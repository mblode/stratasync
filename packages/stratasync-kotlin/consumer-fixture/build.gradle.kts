plugins { application }
repositories {
    maven { url = rootDir.resolve("../build/repository").toURI() }
    mavenCentral()
}
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
dependencies { implementation("dev.stratasync:stratasync-kotlin:0.1.0-SNAPSHOT") }
application { mainClass = "Consumer" }
