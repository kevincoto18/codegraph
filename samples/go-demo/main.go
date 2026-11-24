// Command godemo registers a user.
package main

import (
	"fmt"

	"example.com/godemo/internal/service"
	store "example.com/godemo/internal/storage"
)

func main() {
	repo := store.NewMemoryRepo()
	svc := service.New(repo)
	if err := svc.Register("ana"); err != nil {
		fmt.Println(err)
	}
	run()
}
