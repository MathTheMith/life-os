// Downscales and re-encodes an image before it goes into a chat message —
// a raw phone photo can be several MB, and a saved conversation resends
// every attached image in full on every single turn of that conversation
// (see chat.ts), so keeping this small matters a lot more than usual.
const MAX_DIMENSION = 1280
const JPEG_QUALITY = 0.82

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap decodes off the main thread and doesn't have the iOS
  // Safari quirk below — prefer it wherever it exists.
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file)
    } catch {
      // falls through to the <img> path below (older/unsupported format)
    }
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })

  const img = new window.Image()
  img.src = dataUrl
  // img.onload alone isn't a strong enough guarantee on iOS Safari — it can
  // fire before the frame is actually decoded, which left drawImage() below
  // painting nothing and toDataURL() then exporting the untouched canvas as
  // a solid black JPEG (canvas has no alpha channel to fall back to
  // transparent). decode() waits for the real thing.
  if (typeof img.decode === 'function') {
    await img.decode()
  } else {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Image illisible.'))
    })
  }
  return img
}

export async function resizeImageFile(file: File): Promise<string> {
  const source = await loadBitmap(file)
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height
  if (!width || !height) throw new Error("Image illisible (dimensions nulles).")

  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas indisponible.')
  // JPEG has no alpha channel — anything left transparent on the canvas
  // would otherwise export as solid black instead of white.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}
