# Homebrew formula for the Vobiz CLI. The release workflow fills in the version, URLs and sha256 values
# (scripts/update-homebrew-formula.mjs) and opens a pull request with this file to vobiz-ai/homebrew-tap
# as Formula/vobiz.rb. Install: brew install vobiz-ai/tap/vobiz
class Vobiz < Formula
  desc "Official Vobiz CLI: voice calls, SMS, phone numbers, SIP trunks and VobizXML"
  homepage "https://www.vobiz.ai/docs/resources/cli"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v0.1.0/vobiz-0.1.0-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v0.1.0/vobiz-0.1.0-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v0.1.0/vobiz-0.1.0-linux-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/vobiz-ai/Vobiz-CLI/releases/download/v0.1.0/vobiz-0.1.0-linux-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    bin.install "vobiz"
    bash_completion.install "completions/vobiz.bash" => "vobiz" if File.exist?("completions/vobiz.bash")
    zsh_completion.install "completions/_vobiz" if File.exist?("completions/_vobiz")
    fish_completion.install "completions/vobiz.fish" if File.exist?("completions/vobiz.fish")
    man1.install "man/vobiz.1" if File.exist?("man/vobiz.1")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/vobiz --version")
    ENV["VOBIZ_CONFIG_DIR"] = testpath/"config"
    ENV["VOBIZ_NO_UPDATE_CHECK"] = "1"
    assert_match "vobiz", shell_output("#{bin}/vobiz --help")
  end
end
