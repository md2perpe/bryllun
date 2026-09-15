const REPO = "md2perpe/bryllun";

async function detectPlatform() {
  const ua = navigator.userAgent;
  const platform = navigator.platform || "";
  const isMac = /Mac/i.test(platform) || /Macintosh/i.test(ua);

  if (isMac) {
    // navigator.platform reports "MacIntel" on Apple Silicon too (Rosetta
    // compatibility), so ask the high-entropy Client Hints API when it's
    // available (Chromium); Safari/Firefox fall back to assuming Apple
    // Silicon, since that's what new Macs ship with today.
    if (navigator.userAgentData?.getHighEntropyValues) {
      try {
        const hints = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
        if (hints.architecture) return { os: "mac", arm: hints.architecture !== "x86" };
      } catch {
        // fall through to the default below
      }
    }
    return { os: "mac", arm: true };
  }
  if (/Win/i.test(platform)) return { os: "windows", arm: false };
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) {
    return { os: "linux", arm: /arm|aarch64/i.test(ua) };
  }
  return { os: null, arm: false };
}

function findAsset(assets, predicate) {
  return assets.find(predicate) || null;
}

function link(asset, label) {
  if (!asset) return "";
  return `<a class="btn btn-primary btn-small" href="${asset.browser_download_url}">${label} (${formatSize(asset.size)})</a>`;
}

function smallLink(asset, label) {
  if (!asset) return "";
  return `<a href="${asset.browser_download_url}">${label}</a>`;
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

async function loadRelease() {
  const sub = document.getElementById("release-sub");
  const grid = document.getElementById("platform-grid");

  let release;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    release = await res.json();
  } catch (err) {
    sub.textContent = "Couldn't reach GitHub to fetch the latest release.";
    grid.querySelectorAll(".platform-links").forEach((el) => {
      el.innerHTML = `<a class="btn btn-ghost btn-small" href="https://github.com/${REPO}/releases">See releases on GitHub</a>`;
    });
    document.getElementById("hero-download-label").textContent = "See releases";
    document.getElementById("hero-download-btn").href = `https://github.com/${REPO}/releases`;
    return;
  }

  const version = release.tag_name?.replace(/^v/, "") || release.name;
  sub.innerHTML = `Latest version: <strong>${version}</strong> · <a href="${release.html_url}">release notes</a>`;

  const assets = release.assets || [];

  const macArm = findAsset(assets, (a) => a.name.endsWith("_aarch64.dmg"));
  const macIntel = findAsset(assets, (a) => a.name.endsWith("_x64.dmg"));

  const winSetup = findAsset(assets, (a) => a.name.endsWith("-setup.exe"));
  const winMsi = findAsset(assets, (a) => a.name.endsWith(".msi"));

  const linuxDebAmd = findAsset(assets, (a) => a.name.endsWith("_amd64.deb"));
  const linuxDebArm = findAsset(assets, (a) => a.name.endsWith("_arm64.deb"));
  const linuxRpmX86 = findAsset(assets, (a) => a.name.endsWith(".x86_64.rpm"));
  const linuxRpmArm = findAsset(assets, (a) => a.name.endsWith(".aarch64.rpm"));
  const linuxAppImageAmd = findAsset(assets, (a) => a.name.endsWith("_amd64.AppImage"));
  const linuxAppImageArm = findAsset(assets, (a) => a.name.endsWith("_aarch64.AppImage"));

  const detected = await detectPlatform();

  // macOS card
  document.querySelector('[data-slot="mac"]').innerHTML = `
    ${link(macArm, "Download for Apple Silicon")}
    <div class="secondary-links">
      ${smallLink(macIntel, "Intel Mac (.dmg)")}
    </div>
  `;

  // Windows card
  document.querySelector('[data-slot="windows"]').innerHTML = `
    ${link(winSetup, "Download installer")}
    <div class="secondary-links">
      ${smallLink(winMsi, ".msi package")}
    </div>
  `;

  // Linux card
  document.querySelector('[data-slot="linux"]').innerHTML = `
    ${link(linuxAppImageAmd, "AppImage (x86_64)")}
    <div class="secondary-links">
      ${smallLink(linuxDebAmd, ".deb (amd64)")}
      ${smallLink(linuxRpmX86, ".rpm (x86_64)")}
      ${smallLink(linuxAppImageArm, "AppImage (ARM64)")}
      ${smallLink(linuxDebArm, ".deb (arm64)")}
      ${smallLink(linuxRpmArm, ".rpm (aarch64)")}
    </div>
  `;

  // Hero CTA + recommended card, based on detected OS
  const heroBtn = document.getElementById("hero-download-btn");
  const heroLabel = document.getElementById("hero-download-label");
  let heroAsset = null;
  let heroText = "Download";
  let recommendedPlatform = detected.os;

  if (detected.os === "mac") {
    heroAsset = detected.arm ? macArm : macIntel;
    heroText = `Download for Mac${detected.arm ? " (Apple Silicon)" : " (Intel)"}`;
  } else if (detected.os === "windows") {
    heroAsset = winSetup;
    heroText = "Download for Windows";
  } else if (detected.os === "linux") {
    heroAsset = detected.arm ? linuxAppImageArm : linuxAppImageAmd;
    heroText = "Download for Linux";
  }

  if (heroAsset) {
    heroBtn.href = heroAsset.browser_download_url;
    heroLabel.textContent = heroText;
  } else {
    heroBtn.href = "#download";
    heroLabel.textContent = "Download";
  }

  if (recommendedPlatform) {
    const card = document.querySelector(`.platform-card[data-platform="${recommendedPlatform}"]`);
    if (card) card.classList.add("recommended");
  }
}

loadRelease();
