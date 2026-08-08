package com.domicilioswil.app

import android.graphics.*
import com.bumptech.glide.load.engine.bitmap_recycle.BitmapPool
import com.bumptech.glide.load.resource.bitmap.BitmapTransformation
import java.security.MessageDigest

/**
 * Transform de Glide que recorta la imagen en círculo
 * desplazando el centro hacia arriba (yOffset entre 0.0 y 1.0)
 * para que el rostro quede visible en fotos de perfil.
 *
 * Uso:
 *   .transform(FaceCircleCrop())          // desplazamiento por defecto (30% arriba)
 *   .transform(FaceCircleCrop(0.25f))     // personalizado
 */
class FaceCircleCrop(
    private val yOffset: Float = 0.30f   // 0.0 = centro exacto, 1.0 = todo arriba
) : BitmapTransformation() {

    override fun transform(
        pool: BitmapPool,
        toTransform: Bitmap,
        outWidth: Int,
        outHeight: Int
    ): Bitmap {
        val size   = minOf(toTransform.width, toTransform.height)
        val output = pool.get(size, size, Bitmap.Config.ARGB_8888)
        output.eraseColor(Color.TRANSPARENT)

        val canvas = Canvas(output)
        val paint  = Paint(Paint.ANTI_ALIAS_FLAG)

        // Dibujar círculo blanco de recorte
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)

        // Aplicar modo SRC_IN para recortar la imagen al círculo
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)

        // Calcular origen del crop desplazado hacia arriba
        val srcX = (toTransform.width  - size) / 2f
        // yOffset 0 = centro, positivo = sube el crop (muestra más la cabeza)
        val rawY  = (toTransform.height - size) / 2f
        val shift = rawY * yOffset
        val srcY  = (rawY - shift).coerceAtLeast(0f)

        val src = Rect(srcX.toInt(), srcY.toInt(), (srcX + size).toInt(), (srcY + size).toInt())
        val dst = RectF(0f, 0f, size.toFloat(), size.toFloat())

        canvas.drawBitmap(toTransform, src, dst, paint)

        return output
    }

    override fun equals(other: Any?) =
        other is FaceCircleCrop && other.yOffset == yOffset

    override fun hashCode() = ID.hashCode() + yOffset.hashCode()

    override fun updateDiskCacheKey(messageDigest: MessageDigest) {
        messageDigest.update((ID + yOffset).toByteArray(CHARSET))
    }

    companion object {
        private const val ID = "com.domicilioswil.app.FaceCircleCrop"
    }
}