package android.util;
import java.io.*;
import java.nio.file.*;
/** Test-only durable-file adapter; not a claim about Android AtomicFile runtime. */
public final class AtomicFile {
  private final File base,backup;
  public AtomicFile(File base) { this.base=base; backup=new File(base.getPath()+".bak"); }
  public File getBaseFile() { return base; }
  public FileInputStream openRead() throws IOException {
    if(backup.exists()) Files.move(backup.toPath(),base.toPath(),StandardCopyOption.REPLACE_EXISTING);
    return new FileInputStream(base);
  }
  public FileOutputStream startWrite() throws IOException {
    base.getParentFile().mkdirs();
    if(base.exists())Files.move(base.toPath(),backup.toPath(),StandardCopyOption.REPLACE_EXISTING);
    return new FileOutputStream(base);
  }
  public void finishWrite(FileOutputStream stream) throws IOException { stream.flush();stream.getFD().sync();stream.close();Files.deleteIfExists(backup.toPath()); }
  public void failWrite(FileOutputStream stream) throws IOException { stream.close();Files.deleteIfExists(base.toPath());if(backup.exists())Files.move(backup.toPath(),base.toPath(),StandardCopyOption.REPLACE_EXISTING); }
}
