package main

import "fmt"

// run prints a greeting from another file of package main.
func run() {
	fmt.Println(greeting())
}

func greeting() string {
	return "done"
}
