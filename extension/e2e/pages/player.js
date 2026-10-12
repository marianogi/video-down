// Imitates an MSE player: the <video> gets a blob: URL, a duration, and the manifest is fetched over the network.
export async function msePlayer(manifestUrl, duration = 6) {
  const video = document.querySelector("video");
  const source = new MediaSource();
  source.addEventListener("sourceopen", () => {
    try {
      source.duration = duration;
    } catch {
      // ignore
    }
  });
  video.src = URL.createObjectURL(source);
  if (manifestUrl) await fetch(manifestUrl).then((r) => r.text());
}
