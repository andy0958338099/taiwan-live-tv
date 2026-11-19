# Media3 / ExoPlayer
-dontwarn androidx.media3.**
-keep class androidx.media3.exoplayer.** { *; }
-keep class androidx.media3.common.** { *; }
-keep class androidx.media3.ui.** { *; }

# org.json 由 Android 平台提供，實測機上不需要混淆處理
-dontwarn org.json.**

# Kotlin
-dontwarn kotlinx.coroutines.**
