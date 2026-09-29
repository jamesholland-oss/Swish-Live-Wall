import Foundation
import Vision
import ImageIO

struct OCRLine: Codable {
    let frame: Int
    let text: String
    let confidence: Float
    let area: Double
    let x: Double
    let y: Double
}

func recognize(path: String, frame: Int) -> [OCRLine] {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        return []
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.012
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

let paths = Array(CommandLine.arguments.dropFirst())
var results: [OCRLine] = []
for (index, path) in paths.enumerated() {
    results.append(contentsOf: recognize(path: path, frame: index))
}

let encoder = JSONEncoder()
if let data = try? encoder.encode(results),
   let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    print("[]")
}
