# Bouwt lokaal op de gedeelde base-devimage (gebouwd door `huddle images build` of de gateway).
ARG BASE_IMAGE=localhost/huddle/base-devimage:latest
FROM ${BASE_IMAGE}

# JB Gateway downloadt zelf de JBR/JDK in de RemoteDev-dist. Als je java/mvn
# ook in je terminal wil, voeg dan apt-install temurin-21-jdk maven toe.

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-intellij
LABEL com.devcontainer.ide=intellij

# Geen ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
