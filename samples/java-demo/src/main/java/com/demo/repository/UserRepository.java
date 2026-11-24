package com.demo.repository;

import com.demo.model.User;
import java.util.HashMap;
import java.util.Map;

/** Keeps users in memory. */
public class UserRepository extends BaseRepository<User> {
    private final Map<String, User> users = new HashMap<>();

    @Override
    public void save(User user) {
        validate(user);
        users.put(user.getName(), user);
        log("saved");
    }

    @Override
    public User find(String key) {
        return users.get(key);
    }

    private void validate(User user) {
        if (user.getName().isEmpty()) {
            throw new IllegalArgumentException("empty name");
        }
    }
}
