// Asset generation only: encode captured fluid frames with macOS's H.264 encoder.
import Foundation
import AVFoundation
import ImageIO
import CoreGraphics

let frames = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let count = Int(CommandLine.arguments[3])!
let fps = Int32(CommandLine.arguments[4])!
let size = 192
try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: size, AVVideoHeightKey: size,
    // Tag the stream; untagged SD video decodes as BT.601 on some Windows paths and shifts the orb's hues.
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
    ],
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 240_000,
        AVVideoExpectedSourceFrameRateKey: Int(fps),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
        AVVideoAllowFrameReorderingKey: false
    ]
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: size, kCVPixelBufferHeightKey as String: size,
    kCVPixelBufferCGImageCompatibilityKey as String: true,
    kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
])
writer.add(input)
guard writer.startWriting() else { fatalError(writer.error!.localizedDescription) }
writer.startSession(atSourceTime: .zero)
for frame in 0..<count {
    while !input.isReadyForMoreMediaData {
        if writer.status == .failed { fatalError(writer.error!.localizedDescription) }
        Thread.sleep(forTimeInterval: 0.001)
    }
    let url = frames.appendingPathComponent(String(format: "%04d.png", frame))
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    var pixelBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pixelBuffer) == kCVReturnSuccess else { fatalError("No pixel buffer") }
    let buffer = pixelBuffer!
    CVPixelBufferLockBaseAddress(buffer, [])
    let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: size, height: size, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: fps)) else { fatalError(writer.error!.localizedDescription) }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fatalError(writer.error!.localizedDescription) }
print(output.lastPathComponent)
