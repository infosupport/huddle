# Bouwt lokaal op de gedeelde base-devimage (gebouwd door `huddle images build` of de gateway).
ARG BASE_IMAGE=localhost/huddle/base-devimage:latest
FROM ${BASE_IMAGE}

# JB Gateway downloadt zelf de WebStorm-backend (RemoteDev-dist). Node.js 24 zit al
# in base-devimage (nodesource), dus node/npm zijn direct beschikbaar in de terminal
# en voor WebStorm's Node-interpreter. Wil je een andere Node-versie of pnpm/yarn,
# installeer die dan hier.

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-webstorm
LABEL com.devcontainer.ide=webstorm

# Geen ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
