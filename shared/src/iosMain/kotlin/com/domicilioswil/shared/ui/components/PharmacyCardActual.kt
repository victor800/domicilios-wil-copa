package com.domicilioswil.shared.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.interop.UIKitView
import androidx.compose.ui.unit.dp
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSURL
import platform.Foundation.NSURLRequest
import platform.UIKit.UIApplication
import platform.WebKit.WKWebView

@OptIn(ExperimentalForeignApi::class)
actual fun openUrl(url: String) {
    val nsUrl = NSURL.URLWithString(url) ?: return
    UIApplication.sharedApplication.openURL(nsUrl)
}

@OptIn(ExperimentalForeignApi::class)
@Composable
actual fun MapEmbedView(embedUrl: String, modifier: Modifier) {
    UIKitView(
        factory = {
            val webView = WKWebView()
            val url = NSURL.URLWithString(embedUrl)
            if (url != null) {
                webView.loadRequest(NSURLRequest.requestWithURL(url))
            }
            webView
        },
        modifier = modifier
            .fillMaxWidth()
            .height(160.dp)
            .clip(RoundedCornerShape(20.dp))
    )
}
