package dev.stratasync

import kotlinx.serialization.json.*
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.Test
import kotlin.test.*
import java.nio.file.Path
import kotlin.io.path.*

class ConformanceTest {
    private val corpus = Path.of(System.getProperty("stratasync.corpus"))
    private val clientVectors = setOf("parse-sync-id", "compare-sync-id", "parse-sync-action", "parse-delta-packet", "parse-bootstrap-line", "read-ndjson-lines", "map-graphql-action")
    private val excludedVectors = mapOf(
        "build-insert-data" to "Server field-spec encoder, not a client operation",
        "build-update-data" to "Server field-spec encoder, not a client operation",
        "serialize-sync-data" to "Server record serializer",
        "parse-sync-action-output" to "Server action output validation",
        "parse-temporal-input" to "Server field-spec temporal decoder",
        "compute-schema-hash" to "Client-local hash; Kotlin hashes its own registered decoding schema, never compared with a TS hash",
    )
    @Test fun everyVectorIsAccountedFor() {
        assertEquals(corpus.resolve("vectors").listDirectoryEntries("*.json").map { it.nameWithoutExtension }.toSet(), clientVectors + excludedVectors.keys)
        assertTrue(excludedVectors.values.all { it.isNotBlank() })
    }
    @TestFactory fun vectors(): List<DynamicTest> = clientVectors.sorted().flatMap { name ->
        val vector = Json.parseToJsonElement(corpus.resolve("vectors/$name.json").readText()).jsonObject
        vector.array("cases").map { raw ->
            val case = raw.jsonObject
            DynamicTest.dynamicTest("$name: ${case.string("name")}") {
                val input = case.array("input")
                fun evaluate(): JsonElement = when (name) {
                    "parse-sync-id" -> JsonPrimitive(Wire.syncId(input.firstOrNull()))
                    "compare-sync-id" -> JsonPrimitive(Wire.compareIds(input[0].jsonPrimitive.content, input[1].jsonPrimitive.content))
                    "map-graphql-action" -> JsonPrimitive(Wire.mutationCode(input[0].jsonPrimitive.content))
                    "parse-sync-action" -> Wire.action(input[0])
                    "parse-delta-packet" -> Wire.packet(input[0]) ?: JsonNull
                    "parse-bootstrap-line" -> Wire.bootstrapLine(input[0].jsonPrimitive.content)
                    "read-ndjson-lines" -> JsonArray(Wire.ndjsonLines(input[0].jsonArray.joinToString("") { it.jsonPrimitive.content }.reader()).map(::JsonPrimitive).toList())
                    else -> error("Unwired vector $name")
                }
                if (case["throws"] == JsonPrimitive(true)) assertFails { evaluate() } else assertEquals(case["expected"], evaluate())
            }
        }
    }
    @TestFactory fun scenarios(): List<DynamicTest> = corpus.resolve("scenarios").listDirectoryEntries("*.json").sorted().map { file ->
        DynamicTest.dynamicTest(file.nameWithoutExtension) {
            val result = runScenario(Json.parseToJsonElement(file.readText()).jsonObject)
            assertEquals(JsonPrimitive(true), result["ok"], result.toString())
        }
    }
    @Test fun incorrectExpectationFailsTheVerdict() {
        val source = Json.parseToJsonElement(corpus.resolve("scenarios/bootstrap-then-delta.json").readText()).jsonObject
        val steps = source.array("steps").toMutableList()
        steps[0] = patch(steps[0].jsonObject, "state" to JsonPrimitive("syncing"))
        assertEquals(JsonPrimitive(false), runScenario(patch(source, "steps" to JsonArray(steps)))["ok"])
    }
    @Test fun manifestHashesMatchEveryCorpusFile() {
        val manifest = Json.parseToJsonElement(corpus.resolve("manifest.json").readText()).jsonObject
        val hashes = manifest["files"]!!.jsonObject
        hashes.forEach { (file, expected) ->
            val actual = java.security.MessageDigest.getInstance("SHA-256").digest(corpus.resolve(file).readBytes()).joinToString("") { "%02x".format(it) }
            assertEquals(expected.jsonPrimitive.content, actual, file)
        }
    }
}
