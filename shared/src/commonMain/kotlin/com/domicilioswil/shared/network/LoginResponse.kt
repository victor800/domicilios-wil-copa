package com.domicilioswil.shared.network

import kotlinx.serialization.Serializable

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val id: String? = null,
    val nombre: String? = null,
    val rol: String? = null,
    val tel: String? = null,
    val foto: String? = null,
    val error: String? = null
)
