package com.demo.penguin;

import java.util.List;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/penguins")
@CrossOrigin
public class PenguinController {

    private final PenguinRepository repository;

    public PenguinController(PenguinRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public List<Penguin> findAll() {
        return repository.findAll();
    }

    @PostMapping
    public Penguin create(@RequestBody Penguin penguin) {
        return repository.save(penguin);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {
        repository.deleteById(id);
    }
}
