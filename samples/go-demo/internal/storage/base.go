// Package storage keeps users.
package storage

import "fmt"

type base struct {
	prefix string
}

func (b *base) log(message string) {
	fmt.Println(b.prefix + message)
}
