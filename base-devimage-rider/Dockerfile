FROM ghcr.io/infosupport/base-devimage

# JB Gateway downloadt zelf de .NET-runtime in de RemoteDev-dist. Als je dotnet
# ook in je terminal wil, voeg dan apt-install dotnet-sdk-8.0 toe.
# LET OP: pid 1 draait als vscode (non-root). Als de Rider-backend hierop breekt
# (RemoteDev-dist-volume kan root-ownership nodig hebben), verplaats USER vscode
# dan naar dit Dockerfile i.p.v. de base.

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-rider
LABEL com.devcontainer.ide=rider

# Geen ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
