package app.agentero.mobile

import android.app.Activity
import android.content.Context
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.io.IOException

/**
 * Materializes the read-only dictionary from APK assets into app-private
 * storage. SQLite needs a real seekable file; `resource_dir()` on Android is
 * an `asset://localhost/` URI and APK entries are owned by AssetManager.
 *
 * The copy is versioned by `dictionary/version.txt`, written through a
 * temporary file, and serialized so concurrent lookups cannot interleave.
 */
internal object DictionaryAssets {
    private const val ASSET = "dictionary/lexicon.sqlite"
    private const val VERSION_ASSET = "dictionary/version.txt"
    private val lock = Any()

    fun ensure(activity: Activity, invoke: Invoke) {
        val context = activity.applicationContext
        Thread({
            try {
                val path = synchronized(lock) { materialize(context) }
                activity.runOnUiThread {
                    invoke.resolve(JSObject().put("path", path.absolutePath))
                }
            } catch (error: Exception) {
                activity.runOnUiThread {
                    invoke.reject(
                        "dictionary unavailable: ${error.message ?: error.javaClass.simpleName}"
                    )
                }
            }
        }, "agentero-dictionary").start()
    }

    private fun materialize(context: Context): File {
        val dir = File(context.filesDir, "dictionary").apply {
            if (!isDirectory && !mkdirs()) throw IOException("cannot create dictionary directory")
        }
        val target = File(dir, "lexicon.sqlite")
        val stamp = File(dir, "version.txt")
        // `version.txt` ships with the dictionary; a missing stamp still
        // produces a usable copy and is replaced on the next app update.
        val version = assetText(context, VERSION_ASSET) ?: "bundled"
        if (target.isFile && target.length() > 0 && stamp.isFile &&
            stamp.readText().trim() == version
        ) {
            return target
        }
        val temp = File(dir, "lexicon.sqlite.tmp")
        context.assets.open(ASSET).use { input ->
            temp.outputStream().use { output -> input.copyTo(output) }
        }
        if (temp.length() <= 0) {
            temp.delete()
            throw IOException("bundled dictionary is empty")
        }
        if (target.exists() && !target.delete()) {
            temp.delete()
            throw IOException("cannot replace stale dictionary")
        }
        if (!temp.renameTo(target)) {
            temp.delete()
            throw IOException("cannot commit dictionary")
        }
        stamp.writeText(version)
        return target
    }

    private fun assetText(context: Context, name: String): String? = try {
        context.assets.open(name).bufferedReader().use { it.readText().trim() }
    } catch (_: IOException) {
        null
    }
}