package com.demo;

import com.demo.model.User;
import com.demo.repository.UserRepository;
import com.demo.service.UserService;
import com.demo.util.*;

/** Entry point of the demo. */
public class App {
    public static void main(String[] args) {
        UserService service = new UserService(new UserRepository());
        service.register("ana");
        Logger.info("started");
        printUser(new User("bob"));
    }

    private static void printUser(User user) {
        Logger.info(user.getName());
    }
}
