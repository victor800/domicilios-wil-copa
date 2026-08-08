package com.domicilioswil.shared.model

data class Farmacia(
    val nombre: String,
    val direccion: String,
    val horario: String,
    val etiqueta: String,
    val icono: String,
    val mapsUrl: String,
    val pedidoUrl: String
)

val farmaciasWil = listOf(
    Farmacia(
        nombre = "Droguería Farma Expertos",
        direccion = "Cra 47 #51-69, Copacabana",
        horario = "Lun–Sáb 7am–9pm",
        etiqueta = "Formulados",
        icono = "💊",
        mapsUrl = "https://www.google.com/maps/place/DROGUERIA+FARMA+EXPERTOS/@6.34911,-75.5087659,17z",
        pedidoUrl = "https://domicilios-wil.vercel.app/pedido-farmacia.html?tienda=expertos"
    ),
    Farmacia(
        nombre = "Droguería Central",
        direccion = "Calle 52 #48-09, Copacabana",
        horario = "Lun–Dom 7am–10pm",
        etiqueta = "Genéricos",
        icono = "🏥",
        mapsUrl = "https://www.google.com/maps/place/Droguer%C3%ADa+Central/@6.3485472,-75.509965,17z",
        pedidoUrl = "https://domicilios-wil.vercel.app/pedido-farmacia.html?tienda=central"
    )
)
