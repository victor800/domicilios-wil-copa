package com.domicilioswil.app

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment

class PerfilClienteFragment : Fragment() {

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val tv = TextView(requireContext())
        tv.text = "👤 Perfil — próximamente"
        tv.textSize = 20f
        tv.setTextColor(android.graphics.Color.parseColor("#F1F5F9"))
        tv.gravity = android.view.Gravity.CENTER
        tv.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        return tv
    }
}