#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private struct TrayIconError: Error, CustomStringConvertible {
    let description: String
}

private struct AlphaBounds {
    let minX: Int
    let minY: Int
    let maxX: Int
    let maxY: Int

    var width: Int { maxX - minX + 1 }
    var height: Int { maxY - minY + 1 }
    var centerX: CGFloat { CGFloat(minX + maxX + 1) / 2 }
    var centerY: CGFloat { CGFloat(minY + maxY + 1) / 2 }
}

private let scriptURL = URL(fileURLWithPath: #filePath).standardizedFileURL
private let projectRoot = scriptURL
    .deletingLastPathComponent()
    .deletingLastPathComponent()
private let sourceURL = projectRoot.appendingPathComponent("src/assets/app-tray-icon.png")
private let outputDirectory = projectRoot.appendingPathComponent("src-tauri/icons")
private let outputs = [
    (size: 18, name: "tray-icon.png"),
    (size: 36, name: "tray-icon@2x.png"),
]

private func loadImage(at url: URL) throws -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw TrayIconError(description: "Unable to decode \(url.path)")
    }
    return image
}

private func rgbaPixels(for image: CGImage) throws -> [UInt8] {
    let bytesPerRow = image.width * 4
    var pixels = [UInt8](repeating: 0, count: bytesPerRow * image.height)
    guard let context = CGContext(
        data: &pixels,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw TrayIconError(description: "Unable to create source bitmap context")
    }
    context.draw(
        image,
        in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
    )
    return pixels
}

private func alphaBounds(in image: CGImage) throws -> AlphaBounds {
    let pixels = try rgbaPixels(for: image)
    let bytesPerRow = image.width * 4
    var minX = image.width
    var minY = image.height
    var maxX = -1
    var maxY = -1

    for y in 0..<image.height {
        for x in 0..<image.width {
            let alpha = pixels[(y * bytesPerRow) + (x * 4) + 3]
            guard alpha > 0 else { continue }
            minX = min(minX, x)
            minY = min(minY, y)
            maxX = max(maxX, x)
            maxY = max(maxY, y)
        }
    }

    guard maxX >= minX, maxY >= minY else {
        throw TrayIconError(description: "Source artwork contains no visible pixels")
    }
    return AlphaBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}

private func squareCrop(for bounds: AlphaBounds, image: CGImage) -> CGRect {
    // Six percent breathing room on each side keeps the mark legible without
    // allowing it to touch the macOS menu-bar image bounds.
    let paddedSide = ceil(CGFloat(max(bounds.width, bounds.height)) * 1.12)
    let side = min(paddedSide, CGFloat(min(image.width, image.height)))
    let originX = max(0, min(CGFloat(image.width) - side, bounds.centerX - (side / 2)))
    let originY = max(0, min(CGFloat(image.height) - side, bounds.centerY - (side / 2)))
    return CGRect(x: originX, y: originY, width: side, height: side).integral
}

private func makeTemplateIcon(from source: CGImage, crop: CGRect, size: Int) throws -> CGImage {
    guard let cropped = source.cropping(to: crop) else {
        throw TrayIconError(description: "Unable to crop the source artwork")
    }

    // Render at 4x, expand the alpha mask by half an output pixel on each
    // edge, then downsample. This adds exactly one output pixel to the total
    // stroke width without changing the silhouette's scale or safe margins.
    let supersample = 4
    let renderSize = size * supersample
    let renderBytesPerRow = renderSize * 4
    var renderPixels = [UInt8](repeating: 0, count: renderBytesPerRow * renderSize)
    guard let renderContext = CGContext(
        data: &renderPixels,
        width: renderSize,
        height: renderSize,
        bitsPerComponent: 8,
        bytesPerRow: renderBytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw TrayIconError(description: "Unable to create supersampled bitmap context")
    }

    renderContext.interpolationQuality = .high
    renderContext.draw(
        cropped,
        in: CGRect(x: 0, y: 0, width: renderSize, height: renderSize)
    )

    let sourceAlpha = stride(from: 3, to: renderPixels.count, by: 4).map {
        renderPixels[$0]
    }
    let dilationRadius = supersample / 2

    for y in 0..<renderSize {
        for x in 0..<renderSize {
            var expandedAlpha: UInt8 = 0
            for offsetY in -dilationRadius...dilationRadius {
                for offsetX in -dilationRadius...dilationRadius
                where (offsetX * offsetX) + (offsetY * offsetY)
                    <= dilationRadius * dilationRadius
                {
                    let sampleX = x + offsetX
                    let sampleY = y + offsetY
                    guard
                        sampleX >= 0,
                        sampleX < renderSize,
                        sampleY >= 0,
                        sampleY < renderSize
                    else { continue }
                    expandedAlpha = max(
                        expandedAlpha,
                        sourceAlpha[(sampleY * renderSize) + sampleX]
                    )
                }
            }

            let pixelOffset = (y * renderBytesPerRow) + (x * 4)
            renderPixels[pixelOffset] = 0
            renderPixels[pixelOffset + 1] = 0
            renderPixels[pixelOffset + 2] = 0
            renderPixels[pixelOffset + 3] = expandedAlpha
        }
    }

    guard let thickenedImage = renderContext.makeImage() else {
        throw TrayIconError(description: "Unable to create the thickened tray image")
    }

    let outputBytesPerRow = size * 4
    var outputPixels = [UInt8](repeating: 0, count: outputBytesPerRow * size)
    guard let outputContext = CGContext(
        data: &outputPixels,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: outputBytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw TrayIconError(description: "Unable to create \(size)x\(size) bitmap context")
    }

    // macOS template images use alpha as the mask. Normalizing RGB to black
    // also leaves a sensible monochrome image on platforms that ignore the
    // template flag.
    // The 1x fallback needs one pixel of additional protection after dilation;
    // the 36px Retina asset keeps the approved scale unchanged.
    let fallbackInset: CGFloat = size == 18 ? 1 : 0
    let outputRect = CGRect(
        x: fallbackInset,
        y: fallbackInset,
        width: CGFloat(size) - (fallbackInset * 2),
        height: CGFloat(size) - (fallbackInset * 2)
    )
    outputContext.interpolationQuality = .high
    outputContext.draw(thickenedImage, in: outputRect)

    guard let image = outputContext.makeImage() else {
        throw TrayIconError(description: "Unable to create the \(size)x\(size) tray image")
    }
    return image
}

private func writePNG(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw TrayIconError(description: "Unable to create \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw TrayIconError(description: "Unable to write \(url.path)")
    }
}

do {
    let source = try loadImage(at: sourceURL)
    let bounds = try alphaBounds(in: source)
    let crop = squareCrop(for: bounds, image: source)

    for output in outputs {
        let image = try makeTemplateIcon(from: source, crop: crop, size: output.size)
        let url = outputDirectory.appendingPathComponent(output.name)
        try writePNG(image, to: url)
        print("Generated \(output.size)x\(output.size): \(url.path)")
    }
} catch {
    FileHandle.standardError.write(Data("Tray icon generation failed: \(error)\n".utf8))
    exit(1)
}
