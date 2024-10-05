{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = inputs:
    inputs.flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = (import (inputs.nixpkgs) { inherit system; });
      in {
        devShell = pkgs.mkShell {
          name = "node22";
          buildInputs=[
            pkgs.deno
            pkgs.nodePackages.typescript-language-server
            pkgs.yq
            pkgs.curl
            pkgs.fish
            pkgs.jq
            pkgs.mongodb-tools
          ];
        };
      }
    );
}
