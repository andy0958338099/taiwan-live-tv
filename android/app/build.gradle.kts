plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.taiwanlivetv"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.taiwanlivetv"
        // minSdk 23 (Android 6.0)：Media3 1.11.x 的最低要求。
        // 這涵蓋 Android 6 以上的所有常見電視盒（實務上 Android 9 以上）。
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    androidResources {
        localeFilters += listOf("zh", "en", "b+zh+Hant")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Media3 / AndroidX 需要 desugaring 支援 java.time 等 API
        isCoreLibraryDesugaringEnabled = true
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        viewBinding = true
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/DEPENDENCIES",
                "META-INF/*.version"
            )
        }
    }

    lint {
        abortOnError = false
        warningsAsErrors = false
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.fragment:fragment-ktx:1.8.6")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.constraintlayout:constraintlayout:2.2.1")

    // Media3 — ExoPlayer + HLS
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    implementation("androidx.media3:media3-datasource:1.11.1")
    implementation("androidx.media3:media3-common:1.11.1")

    // Android TV：Launcher's LEANBACK intent filter 已在 Manifest 設定
    // 這裡使用 androidx.leanback 提供電視友善的 focus / 瀏覽基礎元件
    implementation("androidx.leanback:leanback:1.2.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
