package com.demo.repository;

import com.demo.util.Logger;

/** Shared behavior of the repositories. */
public abstract class BaseRepository<T> implements Repository<T> {
    protected void log(String message) {
        Logger.info(message);
    }

    public void flush() {
        log("flush");
    }
}
