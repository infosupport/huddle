package com.demo.penguin;

import org.springframework.data.jpa.repository.JpaRepository;

public interface PenguinRepository extends JpaRepository<Penguin, Long> {
}
