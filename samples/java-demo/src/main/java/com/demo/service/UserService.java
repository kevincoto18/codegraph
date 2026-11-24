package com.demo.service;

import com.demo.model.User;
import com.demo.repository.UserRepository;
import com.demo.util.Logger;

/** Registers users. */
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public void register(String name) {
        var user = new User(name);
        repository.save(user);
        this.repository.flush();
        notify(user);
    }

    private void notify(User user) {
        Logger.info("registered " + user.getName());
    }
}
