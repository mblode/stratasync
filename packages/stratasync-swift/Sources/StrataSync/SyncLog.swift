import Foundation
import os

/// Shared structured logging for the sync engine.
///
/// Diagnose live-sync issues with: `log stream --predicate 'subsystem == "com.donebear.stratasync"'`
/// or filter by category (`transport`, `delta`) in Console.app.
enum SyncLog {
    static let transport = Logger(subsystem: "com.donebear.stratasync", category: "transport")
    static let delta = Logger(subsystem: "com.donebear.stratasync", category: "delta")
}
