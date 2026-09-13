// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "stratasync-swift",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "StrataSync",
            targets: ["StrataSync"]
        ),
    ],
    targets: [
        .target(
            name: "StrataSync",
            path: "packages/stratasync-swift/Sources/StrataSync",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
        .testTarget(
            name: "StrataSyncTests",
            dependencies: ["StrataSync"],
            path: "packages/stratasync-swift/Tests/StrataSyncTests",
            resources: [
                // Resource copy of this repository's canonical corpus.
                // npm run native:corpus:sync refreshes it; CI checks exact
                // byte equality, not merely internal manifest integrity.
                .copy("Resources/corpus"),
            ]
        ),
    ]
)
