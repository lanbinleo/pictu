package main

import (
	"log"

	"pictu/server/internal/api"
	"pictu/server/internal/config"
	"pictu/server/internal/evolink"
	"pictu/server/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(cfg.Database.Path)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	server := api.New(cfg, st, evolink.New(cfg.Evolink))
	if err := server.Run(); err != nil {
		log.Fatal(err)
	}
}
