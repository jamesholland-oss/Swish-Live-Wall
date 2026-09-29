import Foundation
import Vision
import AVFoundation
import CoreGraphics

struct OCRLine: Codable {
    let frame: Int
    let text: String
    let confidence: Float
    let area: Double
    let x: Double
    let y: Double
}

struct OCRResult: Codable {
    let framesAttempted: Int
    let framesCaptured: Int
    let lines: [OCRLine]
    let errors: [String]
}

func recognize(image: CGImage, frame: Int) -> [OCRLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.010
    request.recognitionLanguages = ["en-US"]

    // Only inspect the lower portion of the vertical show frame where cards are
    // intentionally presented. Vision uses normalized coordinates with a
    // bottom-left origin, so this excludes host/marketing banners above.
    request.regionOfInterest = CGRect(x: 0.0, y: 0.0, width: 1.0, height: 0.60)

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }

    guard let observations = request.results else { return [] }
    return observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return OCRLine(
            frame: frame,
            text: candidate.string,
            confidence: candidate.confidence,
            area: Double(box.width * box.height),
            x: Double(box.midX),
            y: Double(box.midY)
        )
    }
}

func processVideo(path: String) -> OCRResult {
    let ratios: [Double] = [0.08, 0.20, 0.32, 0.45, 0.58, 0.70, 0.82, 0.90, 0.96]
    let url = URL(fileURLWithPath: path)
    let asset = AVURLAsset(url: url)

    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite && durationSeconds > 0 else {
        return OCRResult(
            framesAttempted: ratios.count,
            framesCaptured: 0,
            lines: [],
            errors: ["Unable to read replay duration with AVFoundation."]
        )
    }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1920, height: 1920)
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.35, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.35, preferredTimescale: 600)

    var lines: [OCRLine] = []
    var captured = 0
    var errors: [String] = []

    for (index, ratio) in ratios.enumerated() {
        let seconds = max(0, min(durationSeconds - 0.05, durationSeconds * ratio))
        let time = CMTime(seconds: seconds, preferredTimescale: 600)

        do {
            let image = try generator.copyCGImage(at: time, actualTime: nil)
            captured += 1
            lines.append(contentsOf: recognize(image: image, frame: index))
        } catch {
            errors.append(String(format: "Frame %d at %.2fs: %@", index + 1, seconds, error.localizedDescription))
        }
    }

    return OCRResult(
        framesAttempted: ratios.count,
        framesCaptured: captured,
        lines: lines,
        errors: errors
    )
}

let args = Array(CommandLine.arguments.dropFirst())
guard let videoPath = args.first, !videoPath.isEmpty else {
    let result = OCRResult(framesAttempted: 0, framesCaptured: 0, lines: [], errors: ["Replay path is required."])
    let data = try! JSONEncoder().encode(result)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

let result = processVideo(path: videoPath)
let encoder = JSONEncoder()
if let data = try? encoder.encode(result),
   let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    print("{\"framesAttempted\":0,\"framesCaptured\":0,\"lines\":[],\"errors\":[\"Unable to encode OCR result.\"]}")
}
