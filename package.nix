{
  lib,
  stdenv,
  nodejs,
  pnpm_11,
  pnpmConfigHook,
  fetchPnpmDeps,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "logseq-pr-badges";
  version = "0.1.0";

  src = ./.;

  nativeBuildInputs = [
    nodejs
    pnpm_11
    pnpmConfigHook
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-GuriNfhuJFLLd3tY3YeZyuRxfG4sp9y7cgWoMyGY9KQ=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist package.json icon.svg $out/
    runHook postInstall
  '';

  meta = {
    description = "GitHub pull request state badges for Logseq";
    homepage = "https://github.com/sphaugh/logseq-pr-badges";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
})
