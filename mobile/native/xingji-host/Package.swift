// swift-tools-version:5.9
// T4 xingji-host（iOS）：受信 WebView 边界与受控原生能力的最小插件包。
import PackageDescription

let package = Package(
    name: "XingjiHost",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "XingjiHost", targets: ["XingjiHostPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "XingjiHostPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/XingjiHostPlugin"
        )
    ]
)
