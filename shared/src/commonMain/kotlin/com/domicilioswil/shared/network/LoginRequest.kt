package com.domicilioswil.shared.network

import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    val idWil: String,
    val password: String,
    val rol: String
)
