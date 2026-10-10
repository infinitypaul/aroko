# macOS notification binary (shipped)

PairMesh ships `terminal-notifier.app` based on MIT
[julienXX/terminal-notifier](https://github.com/julienXX/terminal-notifier) **3.0.0**,
rebranded as **PairMesh** (`com.pairmesh.notifier`) so owner-presence notifications
work after install without Homebrew.

- Universal binary (`arm64` + `x86_64`)
- UserNotifications-based; macOS 10.14+
- Deep-link via `-open` on notification click

First delivery may require allowing notifications for **PairMesh** in
System Settings → Notifications. That is a one-time OS permission, not a
Homebrew install step.

Do not treat a separately installed Homebrew `terminal-notifier` as part of the
normal PairMesh user experience.
