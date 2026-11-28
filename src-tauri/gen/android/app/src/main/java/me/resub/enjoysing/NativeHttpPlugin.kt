package me.resub.enjoysing

// Requêtes HTTP faites par la pile réseau d'ANDROID (HttpURLConnection) : même DNS, même proxy, mêmes
// certificats que le reste du téléphone. Sert de secours quand le module HTTP de Rust n'arrive pas à
// sortir (proxy du Wi-Fi, antivirus ou VPN qui inspecte les connexions, DNS particulier…).
// Appelé par la commande Rust « http_natif » (src-tauri/src/androidhttp.rs).

import android.app.Activity
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import org.json.JSONArray

@TauriPlugin
class NativeHttpPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun fetch(invoke: Invoke) {
    val args = invoke.getArgs()
    thread(name = "enjoysing-http") {
      var conn: HttpURLConnection? = null
      try {
        val method = args.optString("method", "GET").ifEmpty { "GET" }.uppercase()
        conn = URL(args.getString("url")).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.useCaches = false
        val headers = args.optJSONArray("headers") ?: JSONArray()
        for (i in 0 until headers.length()) {
          val pair = headers.getJSONArray(i)
          conn.setRequestProperty(pair.getString(0), pair.getString(1))
        }
        val body = if (args.isNull("body")) "" else args.optString("body", "")
        if (body.isNotEmpty() && method != "GET" && method != "HEAD") {
          val bytes = Base64.decode(body, Base64.DEFAULT)
          conn.doOutput = true
          conn.setFixedLengthStreamingMode(bytes.size)
          conn.outputStream.use { it.write(bytes) }
        }
        val status = conn.responseCode
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
        val out = ByteArrayOutputStream()
        stream?.use { it.copyTo(out, 64 * 1024) }

        val resHeaders = JSArray()
        for ((name, values) in conn.headerFields) {
          if (name == null) continue // ligne de statut
          for (v in values) resHeaders.put(JSONArray(listOf(name, v)))
        }
        val ret = JSObject()
        ret.put("status", status)
        ret.put("url", conn.url.toString())
        ret.put("headers", resHeaders)
        ret.put("body", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject("${e.javaClass.simpleName}: ${e.message}")
      } finally {
        conn?.disconnect()
      }
    }
  }
}
