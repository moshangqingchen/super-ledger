package android.content;
import java.io.File;
/** File-directory adapter for testing actual LedgerStore logic on the JDK. */
public class Context {
  private final File directory;
  public Context(File directory) { this.directory=directory; directory.mkdirs(); }
  public Context getApplicationContext() { return this; }
  public File getFilesDir() { return directory; }
}
