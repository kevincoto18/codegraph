package com.demo.repository;

/** Stores entities of one type. */
public interface Repository<T> {
    void save(T entity);

    T find(String key);
}
