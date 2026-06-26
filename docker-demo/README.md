# Pinguin Demo

Demo project met Angular frontend, Spring Boot backend en PostgreSQL.

## Starten

```bash
docker compose up --build
```

Open daarna http://localhost:4200

## Wat doet het?

- Maak een pinguin aan met een naam
- Bekijk alle pinguins
- Verwijder een pinguin

## Architectuur

- **frontend** (Angular 17) → poort 4200
- **backend** (Spring Boot 3, Java 21) → intern poort 8080
- **db** (PostgreSQL 16) → intern poort 5432
