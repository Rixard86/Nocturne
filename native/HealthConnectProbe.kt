package com.nocturne.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

/**
 * Read-only survey of what a wearable has actually written to Health Connect.
 *
 * This exists to answer a question that has to be settled before any of it is designed
 * around: what does the watch really record overnight, at what density, and under whose
 * package name? Fitbit, Samsung Health and the Health Connect app all write here, and what
 * a device advertises on its own dashboard is often not what it exports. Nothing here
 * writes, aggregates or derives — it reports what is on disk.
 */
object HealthConnectProbe {

    // The history permission has no constant in this release of connect-client, but it is a
    // platform permission string and stable. Without it, a read can only ever see 30 days
    // back from the moment permission was first granted.
    const val HISTORY_PERMISSION = "android.permission.health.READ_HEALTH_DATA_HISTORY"

    // The READ_* string constants are marked internal in this release, so the permissions
    // are derived from the record types instead - which is also the pairing that matters:
    // these are exactly the types the probe below reads.
    val READ_PERMISSIONS: Set<String> = setOf(
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(RespiratoryRateRecord::class),
        HISTORY_PERMISSION,
    )

    private const val DEFAULT_DAYS = 30L
    private const val MAX_SESSIONS_REPORTED = 20

    /** A client bound to the window being surveyed, so helpers stay single-argument. */
    private class Scope(val client: HealthConnectClient, val since: Instant)

    fun statusName(context: Context): String = when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update-required"
        else -> "unavailable"
    }

    fun isAvailable(context: Context): Boolean =
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    suspend fun grantedPermissions(context: Context): Set<String> =
        HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()

    /** Everything the probe found, as one object the web UI can print verbatim. */
    suspend fun survey(context: Context, days: Long = DEFAULT_DAYS): JSObject {
        val out = JSObject().put("status", statusName(context))
        if (!isAvailable(context)) return out
        val granted = grantedPermissions(context)
        out.put("granted", JSArray(granted.toTypedArray()))
        out.put("missing", JSArray(READ_PERMISSIONS.minus(granted).toTypedArray()))
        out.put("historyGranted", granted.contains(HISTORY_PERMISSION))
        out.put("days", days)
        if (granted.isEmpty()) return out

        val scope = Scope(
            HealthConnectClient.getOrCreate(context),
            Instant.now().minus(days, ChronoUnit.DAYS)
        )
        out.put("sleep", safely { sleep(scope) })
        out.put("heartRate", safely { heartRate(scope) })
        out.put("hrv", safely { hrv(scope) })
        out.put("respiratoryRate", safely { respiratory(scope) })
        return out
    }

    /**
     * Report a failed read as a failure rather than as an absence. Health Connect throws on
     * a type the app has no permission for, and swallowing that makes a read error look
     * exactly like a wearable that wrote nothing - which are opposite problems.
     */
    private inline fun safely(body: () -> JSObject): JSObject =
        try {
            body()
        } catch (e: Exception) {
            JSObject().put("error", e.message ?: e.javaClass.simpleName)
        }

    private suspend fun <T : Record> read(scope: Scope, type: KClass<T>): List<T> =
        scope.client.readRecords(
            ReadRecordsRequest(type, TimeRangeFilter.after(scope.since))
        ).records

    private fun sources(records: List<Record>): JSArray =
        JSArray(records.map { it.metadata.dataOrigin.packageName }.distinct().toTypedArray())

    private fun minutesBetween(from: Instant, to: Instant): Long =
        ChronoUnit.MINUTES.between(from, to)

    private fun stageName(stage: Int): String =
        SleepSessionRecord.STAGE_TYPE_INT_TO_STRING_MAP[stage] ?: "unknown"

    /** Per-session stage breakdown in minutes — the shape a hypnogram would need. */
    private fun stageMinutes(session: SleepSessionRecord): JSObject {
        val totals = HashMap<String, Long>()
        for (stage in session.stages) {
            val name = stageName(stage.stage)
            totals[name] = (totals[name] ?: 0L) + minutesBetween(stage.startTime, stage.endTime)
        }
        val out = JSObject()
        for ((name, minutes) in totals) out.put(name, minutes)
        return out
    }

    /**
     * Stage boundaries as epoch milliseconds. A night's snore onsets are seconds from its
     * own startMs, so epoch millis on both sides is what makes the two comparable without
     * a timezone anywhere in the arithmetic.
     */
    private fun stageSpans(session: SleepSessionRecord): JSArray {
        val spans = JSArray()
        for (stage in session.stages) {
            spans.put(
                JSObject()
                    .put("stage", stageName(stage.stage))
                    .put("startMs", stage.startTime.toEpochMilli())
                    .put("endMs", stage.endTime.toEpochMilli())
            )
        }
        return spans
    }

    private fun describe(session: SleepSessionRecord): JSObject = JSObject()
        .put("start", session.startTime.toString())
        .put("end", session.endTime.toString())
        .put("startMs", session.startTime.toEpochMilli())
        .put("endMs", session.endTime.toEpochMilli())
        .put("zoneOffset", session.startZoneOffset?.id ?: "")
        .put("minutes", minutesBetween(session.startTime, session.endTime))
        .put("source", session.metadata.dataOrigin.packageName)
        .put("stageCount", session.stages.size)
        .put("stageMinutes", stageMinutes(session))
        .put("stageSpans", stageSpans(session))

    private suspend fun sleep(scope: Scope): JSObject {
        val records = read(scope, SleepSessionRecord::class)
        val recent = records.sortedByDescending { it.startTime }.take(MAX_SESSIONS_REPORTED)
        val sessions = JSArray()
        for (session in recent) sessions.put(describe(session))
        return JSObject()
            .put("count", records.size)
            .put("sources", sources(records))
            .put("staged", records.count { it.stages.isNotEmpty() })
            .put("overlappingPairs", countOverlaps(records))
            .put("sessions", sessions)
    }

    /**
     * When a record was MEASURED, which is not when it was written. A wearable that
     * backfills a week on first sync stamps every one of those records with the same
     * lastModifiedTime, so reporting write time would hide the real span entirely.
     */
    private fun measuredSpan(record: Record): Pair<Instant, Instant> = when (record) {
        // Dispatched on concrete types rather than the IntervalRecord / InstantaneousRecord
        // interfaces, which are public in the bytecode but internal to Kotlin. These four
        // are every type the probe reads.
        is SleepSessionRecord -> record.startTime to record.endTime
        is HeartRateRecord -> record.startTime to record.endTime
        is HeartRateVariabilityRmssdRecord -> record.time to record.time
        is RespiratoryRateRecord -> record.time to record.time
        else -> record.metadata.lastModifiedTime to record.metadata.lastModifiedTime
    }

    /**
     * Sessions that cover the same wall-clock time. Both Fitbit and Samsung Health hold
     * WRITE_SLEEP, and if two apps describe one night, anything that sums across sessions
     * silently double-counts it. Better to know that on day one than to explain a 16-hour
     * night later.
     */
    private fun countOverlaps(sessions: List<SleepSessionRecord>): Int {
        var pairs = 0
        for (i in sessions.indices) {
            for (j in i + 1 until sessions.size) {
                val a = sessions[i]
                val b = sessions[j]
                if (a.startTime < b.endTime && b.startTime < a.endTime) pairs++
            }
        }
        return pairs
    }

    /** Common summary for the vitals series: how many, from whom, and over what span. */
    private fun summarise(records: List<Record>, samples: Int): JSObject {
        val spans = records.map { measuredSpan(it) }
        return JSObject()
            .put("count", records.size)
            .put("samples", samples)
            .put("sources", sources(records))
            .put("firstMeasured", spans.minOfOrNull { it.first }?.toString() ?: "")
            .put("lastMeasured", spans.maxOfOrNull { it.second }?.toString() ?: "")
            .put("lastWritten", records.maxOfOrNull { it.metadata.lastModifiedTime }?.toString() ?: "")
    }

    private suspend fun heartRate(scope: Scope): JSObject {
        val records = read(scope, HeartRateRecord::class)
        return summarise(records, records.sumOf { it.samples.size })
    }

    private suspend fun hrv(scope: Scope): JSObject {
        val records = read(scope, HeartRateVariabilityRmssdRecord::class)
        return summarise(records, records.size)
    }

    private suspend fun respiratory(scope: Scope): JSObject {
        val records = read(scope, RespiratoryRateRecord::class)
        return summarise(records, records.size)
    }
}
