"""Prove root SwiftPM Git packaging without publishing or using sibling checkouts."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="stratasync-consumer-") as directory:
    temp = Path(directory)
    repo = temp / "sdk"
    repo.mkdir()
    shutil.copy(root / "Package.swift", repo)
    shutil.copytree(root / "packages/stratasync-swift", repo / "packages/stratasync-swift", ignore=shutil.ignore_patterns("build", ".build", ".swiftpm", ".DS_Store"))
    def run(args, cwd):
        subprocess.run(args, cwd=cwd, check=True)
    run(["git", "init", "-q"], repo)
    run(["git", "add", "."], repo)
    run(["git", "-c", "user.name=Package Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "SDK packaging fixture"], repo)
    run(["git", "-c", "tag.gpgSign=false", "tag", "0.0.1"], repo)
    consumer = temp / "consumer"
    (consumer / "Sources/Smoke").mkdir(parents=True)
    (consumer / "Package.swift").write_text('''// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "Smoke", platforms: [.macOS(.v14)], dependencies: [
    .package(url: "''' + repo.as_uri() + '''", exact: "0.0.1")
], targets: [.executableTarget(name: "Smoke", dependencies: [.product(name: "StrataSync", package: "sdk")])])
''')
    (consumer / "Sources/Smoke/main.swift").write_text('''import StrataSync
precondition(compareSyncId("9007199254740993", "9007199254740992") > 0)
print("SwiftPM Git consumer passed")
''')
    run(["swift", "run", "Smoke"], consumer)
