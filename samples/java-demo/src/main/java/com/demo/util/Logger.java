package com.demo.util;

/** Minimal console logger. */
public final class Logger {
    private Logger() {}

    public static void info(String message) {
        write("INFO " + message);
    }

    private static void write(String line) {
        System.out.println(line);
    }
}
