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
    // Replay Buffer clips are saved immediately after the interesting card is
    // shown, so sample densely near the end instead of sparsely across the
    // entire replay. This gives Vision several chances to read the same card.
    let offsetsFromEnd: [Double] = [30.0, 25.0, 21.0, 18.0, 15.0, 12.0, 10.0, 8.0, 6.0, 4.0, 2.0, 0.5]
    let url = URL(fileURLWithPath: path)
    let asset = AVURLAsset(url: url)

    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite && durationSeconds > 0 else {
        return OCRResult(
            framesAttempted: offsetsFromEnd.count,
            framesCaptured: 0,
            lines: [],
            errors: ["Unable to read replay duration with AVFoundation."]
        )
    }

    // Clamp short clips safely and remove duplicate timestamps introduced by
    // clamping so one physical frame cannot artificially win by repetition.
    var sampleSeconds: [Double] = []
    for offset in offsetsFromEnd {
        let seconds = max(0, min(durationSeconds - 0.05, durationSeconds - offset))
        if !sampleSeconds.contains(where: { abs($0 - seconds) < 0.05 }) {
            sampleSeconds.append(seconds)
        }
    }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1920, height: 1920)
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.35, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.35, preferredTimescale: 600)

    var lines: [OCRLine] = []
    var captured = 0
    var errors: [String] = []

    for (index, seconds) in sampleSeconds.enumerated() {
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
        framesAttempted: sampleSeconds.count,
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
