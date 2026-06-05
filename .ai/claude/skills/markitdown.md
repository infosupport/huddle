---
name: markitdown
description: Converts non-text files to Markdown for analysis
tools: Bash
model: sonnet
---

# markitdown Skills

`markitdown` converts files to Markdown so you can read and reason about them. Use it whenever you encounter a non-text file (PDF, Word, Excel, PowerPoint, HTML, images, etc.).

```bash
# Convert any supported file to Markdown
markitdown path/to/file.pdf

# Save output to file
markitdown path/to/file.xlsx -o output.md
```

**Supported formats**: PDF, DOCX, PPTX, XLSX, XLS, HTML, CSV, JSON, XML, EPUB, images (EXIF/OCR), audio (metadata), Jupyter notebooks, ZIP archives.

**When to use**: Automatically convert any non-text file before analyzing its contents. Don't ask the user to convert files manually — just run markitdown.
