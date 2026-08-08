package com.domicilioswil.shared.ui.components

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import com.domicilioswil.shared.R

@Composable
actual fun WilLogoImage(modifier: Modifier) {
    Image(
        painter = painterResource(id = R.drawable.logo_wil),
        contentDescription = "Domicilios WIL",
        modifier = modifier
    )
}
