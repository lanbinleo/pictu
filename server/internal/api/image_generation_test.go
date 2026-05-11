package api

import "testing"

func TestRightCodesImageSize(t *testing.T) {
	tests := []struct {
		name       string
		size       string
		resolution string
		want       string
	}{
		{name: "square 1k", size: "1:1", resolution: "1K", want: "1024x1024"},
		{name: "portrait 1k", size: "2:3", resolution: "1K", want: "1024x1536"},
		{name: "landscape 1k", size: "3:2", resolution: "1K", want: "1536x1024"},
		{name: "portrait 2k", size: "2:3", resolution: "2K", want: "2048x3072"},
		{name: "pixel size passthrough", size: "1024x1536", resolution: "1K", want: "1024x1536"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := rightCodesImageSize(tc.size, tc.resolution); got != tc.want {
				t.Fatalf("rightCodesImageSize(%q, %q) = %q, want %q", tc.size, tc.resolution, got, tc.want)
			}
		})
	}
}

func TestRightCodesProgressFromText(t *testing.T) {
	progress, ok := rightCodesProgressFromText("Progressing...\n50% ")
	if !ok || progress != 50 {
		t.Fatalf("rightCodesProgressFromText() = %d, %v; want 50, true", progress, ok)
	}

	progress, ok = rightCodesProgressFromText("95% 100% ")
	if !ok || progress != 100 {
		t.Fatalf("rightCodesProgressFromText() = %d, %v; want 100, true", progress, ok)
	}
}

func TestRightCodesImageURLsFromText(t *testing.T) {
	got := rightCodesImageURLsFromText("\nSuccessfully Generated Image\n\n![image](https://example.com/out.png)")
	if len(got) != 1 || got[0] != "https://example.com/out.png" {
		t.Fatalf("rightCodesImageURLsFromText() = %#v", got)
	}
}
