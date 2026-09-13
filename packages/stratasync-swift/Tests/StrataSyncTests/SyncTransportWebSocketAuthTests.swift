import Foundation
import Testing
@testable import StrataSync

@MainActor
struct SyncTransportWebSocketAuthTests {
    @Test func webSocketRequestUsesAuthorizationHeaderWithoutQueryCredential() throws {
        let secret = "secret+/with?reserved&characters"
        let request = try SyncTransport.makeWebSocketRequest(
            endpoint: "wss://sync.example.com/sync/ws",
            token: secret
        )

        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(secret)")
        #expect(request.url?.absoluteString.contains(secret) == false)
        let url = try #require(request.url)
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == nil)
    }

    @Test func webSocketRequestPreservesNonAuthQueryAndRemovesLegacyToken() throws {
        let request = try SyncTransport.makeWebSocketRequest(
            endpoint: "wss://sync.example.com/sync/ws?region=au&token=legacy-secret&TOKEN=duplicate",
            token: "header-secret"
        )
        let url = try #require(request.url)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))

        #expect(components.queryItems == [URLQueryItem(name: "region", value: "au")])
        #expect(request.url?.absoluteString.contains("legacy-secret") == false)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer header-secret")
    }

    @Test func subscribeFrameRetainsTokenRequiredByCurrentServerProtocol() {
        let message = SyncTransport.makeSubscribeMessage(
            afterSyncId: "42",
            groups: ["workspace-1"],
            token: "body-token"
        )

        #expect(message["type"] as? String == "subscribe")
        #expect(message["afterSyncId"] as? String == "42")
        #expect(message["groups"] as? [String] == ["workspace-1"])
        #expect(message["token"] as? String == "body-token")
    }

}
