/**
 * Prepares pasted or dropped images for a turn: decoded locally, downscaled so the long edge is
 * at most 1568px, and re-encoded as JPEG under ~250 KB. The bytes go to the host, which writes
 * them into the workspace attachment folder; nothing leaves the machine from here.
 */

const MAX_EDGE = 1_568
const TARGET_BYTES = 250 * 1_024
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

export function isImage(file: File): boolean {
  return ACCEPTED.has(file.type)
}

export interface PreparedImage {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly previewUrl: string
  readonly width: number
  readonly height: number
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (context === null) throw new Error("canvas is unavailable")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    let quality = 0.86
    let blob = await toBlob(canvas, quality)
    while (blob.size > TARGET_BYTES && quality > 0.45) {
      quality -= 0.12
      blob = await toBlob(canvas, quality)
    }
    return { data: new Uint8Array(await blob.arrayBuffer()), mediaType: "image/jpeg", previewUrl: URL.createObjectURL(blob), width, height }
  } finally {
    bitmap.close()
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("image encoding failed")) : resolve(blob)), "image/jpeg", quality)
  })
}
