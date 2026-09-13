import Foundation

private let offlineErrorPatterns = [
    "network",
    "fetch",
    "econnrefused",
    "etimedout",
    "enetunreach",
    "timeout",
    "timed out",
    "aborted",
    "offline",
]

public func isOfflineSyncError(_ error: Error) -> Bool {
    if let urlError = error as? URLError {
        return isOfflineURLErrorCode(urlError.code)
    }

    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
        let code = URLError.Code(rawValue: nsError.code)
        return isOfflineURLErrorCode(code)
    }

    if let transportError = error as? SyncTransportError {
        switch transportError {
        case .maxReconnectAttemptsReached:
            return true
        case .subscriptionError(let message):
            return messageContainsOfflinePattern(message)
        default:
            return false
        }
    }

    return messageContainsOfflinePattern(error.localizedDescription)
}

private func isOfflineURLErrorCode(_ code: URLError.Code) -> Bool {
    switch code {
    case .cannotConnectToHost,
         .cannotFindHost,
         .dataNotAllowed,
         .dnsLookupFailed,
         .internationalRoamingOff,
         .networkConnectionLost,
         .notConnectedToInternet,
         .secureConnectionFailed,
         .timedOut:
        true
    default:
        false
    }
}

private func messageContainsOfflinePattern(_ message: String) -> Bool {
    let normalized = message.lowercased()
    return offlineErrorPatterns.contains { normalized.contains($0) }
}
