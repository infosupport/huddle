FROM maven:3.9-eclipse-temurin-21 AS build
ARG http_proxy
ARG https_proxy
ARG HTTPS_PROXY
WORKDIR /app
COPY huddle-ca.crt /usr/local/share/ca-certificates/huddle-ca.crt
RUN keytool -importcert -noprompt -trustcacerts \
    -alias huddle-ca \
    -file /usr/local/share/ca-certificates/huddle-ca.crt \
    -keystore $JAVA_HOME/lib/security/cacerts \
    -storepass changeit
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]
