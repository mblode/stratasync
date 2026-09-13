plugins {
    kotlin("jvm") version "2.3.20"
    `java-library`
    `maven-publish`
}
group = "dev.stratasync"
version = "0.1.0-SNAPSHOT"
kotlin { jvmToolchain(21) }
java { withSourcesJar() }
dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test {
    useJUnitPlatform()
    systemProperty("stratasync.corpus", rootDir.resolve("../conformance/corpus").absolutePath)
    inputs.dir(rootDir.resolve("../conformance/corpus"))
    testLogging { events("failed", "skipped"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
publishing {
    publications { create<MavenPublication>("sdk") { from(components["java"]) } }
    repositories { maven { name = "fixture"; url = layout.buildDirectory.dir("repository").get().asFile.toURI() } }
}
tasks.register<JavaExec>("conformanceDriver") {
    dependsOn(tasks.testClasses)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass = "dev.stratasync.ConformanceDriverKt"
    args(providers.gradleProperty("command").getOrElse("version"))
    standardInput = System.`in`
    systemProperty("stratasync.corpus", rootDir.resolve("../conformance/corpus").absolutePath)
}
