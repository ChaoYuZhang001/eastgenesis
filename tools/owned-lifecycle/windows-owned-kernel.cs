// QA control primitive. No App, WebDriver session, database or Provider operation.
// Reuses the public install QA order: CreateProcess suspended, assign Job, resume.
// Root and descendant authority stays in retained native handles, never PID kill.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace EastGenesisOwnedWindows {
  public sealed class ProofFailure : Exception {
    public readonly string Code;
    public ProofFailure(string code) : base(code) { Code = code; }
  }
  internal static class Check {
    internal static void Need(bool value, string code) { if (!value) throw new ProofFailure(code); }
    internal static void Host() { Need(Environment.OSVersion.Platform == PlatformID.Win32NT, "platform_unsupported"); }
    internal static string PathName(string value) {
      Need(value != null && value.Length > 3 && value.Length < 4096 && value.IndexOf('\0') < 0 && value.IndexOf('\r') < 0 && value.IndexOf('\n') < 0, "path_invalid");
      Need(value.Length > 2 && Char.IsLetter(value[0]) && value[1] == ':' && value[2] == '\\' && value.IndexOf(':',2) < 0, "path_not_drive_absolute");
      Need(Path.GetFullPath(value) == value && !value.EndsWith("\\", StringComparison.Ordinal), "path_not_canonical");
      foreach (string part in value.Substring(3).Split('\\')) Need(part.Length > 0 && part != "." && part != ".." && !String.Equals(part,"MEMORY.md",StringComparison.OrdinalIgnoreCase), "path_forbidden");
      return value;
    }
    internal static void NoReparseAncestors(string value, bool leafExists) {
      PathName(value); string cursor = Path.GetPathRoot(value);
      string[] parts = value.Substring(3).Split('\\');
      for (int i=0;i<parts.Length;i++) {
        cursor=Path.Combine(cursor,parts[i]);
        if (i == parts.Length-1 && !leafExists) continue;
        Need((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)==0,"path_reparse");
      }
    }
    internal static string Hash(byte[] bytes) { using (SHA256 hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
    internal static string HashFile(string path) {
      NoReparseAncestors(path,true);
      using (SafeFileHandle handle=Native.OpenFile(path,Native.GENERIC_READ,false,false)) {
        Native.FileIdentity before=Native.Identity(handle); Need(!before.Directory && !before.Reparse && before.Links==1 && before.Size<=268435456,"input_not_regular");
        using (FileStream stream=new FileStream(handle,FileAccess.Read,65536,false)) {
          string result; using (SHA256 hash=SHA256.Create()) result=BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
          Native.FileIdentity after=Native.Identity(handle); Need(before.Same(after),"input_changed"); return result;
        }
      }
    }
    internal static string Escape(string value) {
      StringBuilder b=new StringBuilder(); foreach(char c in value) {
        if(c=='"')b.Append("\\\"");else if(c=='\\')b.Append("\\\\");else if(c=='\n')b.Append("\\n");else if(c=='\r')b.Append("\\r");else if(c=='\t')b.Append("\\t");else if(c<32)b.Append("\\u").Append(((int)c).ToString("x4"));else b.Append(c);
      } return b.ToString();
    }
  }

  internal static class Native {
    internal const uint GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, DELETE=0x10000;
    internal const uint SYNCHRONIZE=0x100000, QUERY_LIMITED=0x1000, PROCESS_TERMINATE=1;
    [StructLayout(LayoutKind.Sequential)] internal struct FileTime { public uint Low,High; public long Value { get { return ((long)High<<32)|Low; } } }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public uint Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] internal struct FileInfo { public uint Attributes; public FileTime Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IdHigh,IdLow; }
    [StructLayout(LayoutKind.Sequential)] struct AclSize { public uint AceCount,BytesInUse,BytesFree; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Extended { public BasicLimit Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct StartupInfo {
      public uint Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
      public ushort ShowWindow,ReservedSize; public IntPtr ReservedPointer,StdIn,StdOut,StdErr;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct FileDisposition { public byte Delete; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref SecurityAttributes security);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref FileDisposition info,uint size);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,uint objectType,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetAclInformation(IntPtr acl,out AclSize size,uint length,int kind);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetAce(IntPtr acl,uint index,out IntPtr ace);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern IntPtr CreateJobObject(IntPtr attrs,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr info,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint length,out uint returned);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessEx(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder image,ref uint length);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,IntPtr value,uint length,out uint returned);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attrs,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);

    internal sealed class FileIdentity {
      internal readonly uint Volume,IdHigh,IdLow,Links; internal readonly long Size,Write,Creation; internal readonly bool Directory,Reparse;
      internal FileIdentity(FileInfo i) { Volume=i.Volume;IdHigh=i.IdHigh;IdLow=i.IdLow;Links=i.Links;Size=((long)i.SizeHigh<<32)|i.SizeLow;Write=i.Write.Value;Creation=i.Creation.Value;Directory=(i.Attributes&16)!=0;Reparse=(i.Attributes&1024)!=0; }
      internal bool Same(FileIdentity b) { return Volume==b.Volume&&IdHigh==b.IdHigh&&IdLow==b.IdLow&&Links==b.Links&&Size==b.Size&&Write==b.Write&&Creation==b.Creation&&Directory==b.Directory&&Reparse==b.Reparse; }
      internal bool SameObject(FileIdentity b) { return Volume==b.Volume&&IdHigh==b.IdHigh&&IdLow==b.IdLow&&Creation==b.Creation&&Directory==b.Directory&&!b.Reparse; }
      internal string Label { get { return Volume.ToString("x8")+":"+IdHigh.ToString("x8")+IdLow.ToString("x8"); } }
    }
    internal static FileIdentity Identity(SafeFileHandle handle) { FileInfo info;Check.Need(!handle.IsInvalid&&GetFileInformationByHandle(handle,out info),"file_handle_identity");return new FileIdentity(info); }
    internal static SafeFileHandle OpenFile(string path,uint access,bool directory,bool create,bool shareDelete=false) {
      // Input file readers deny concurrent writes/deletes for the retained read.
      SafeFileHandle h=CreateFile(path,access,shareDelete?7u:(directory?3u:1u),IntPtr.Zero,create?1u:3u,0x00200000u|(directory?0x02000000u:0u),IntPtr.Zero);
      Check.Need(!h.IsInvalid,"file_handle_open");return h;
    }
    internal static SafeFileHandle CreateOwnedFile(string path,uint access,string sid) {
      IntPtr descriptor;uint size;Check.Need(ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(A;;FA;;;"+sid+")",1,out descriptor,out size),"acl_descriptor");
      IntPtr attrs=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityAttributes)));
      try { SecurityAttributes s=new SecurityAttributes();s.Length=(uint)Marshal.SizeOf(s);s.Descriptor=descriptor;Marshal.StructureToPtr(s,attrs,false);SafeFileHandle h=CreateFile(path,access,1,attrs,1,0x00200000,IntPtr.Zero);Check.Need(!h.IsInvalid,"owned_file_create");return h; }
      finally { Marshal.FreeHGlobal(attrs);LocalFree(descriptor); }
    }
    internal static void CreateOwnedDirectory(string path,string sid) {
      IntPtr descriptor;uint size;Check.Need(ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(A;OICI;FA;;;"+sid+")",1,out descriptor,out size),"acl_descriptor");
      try { SecurityAttributes s=new SecurityAttributes();s.Length=(uint)Marshal.SizeOf(s);s.Descriptor=descriptor;Check.Need(CreateDirectory(path,ref s),"owned_directory_create"); }finally { LocalFree(descriptor); }
    }
    internal static void CheckOwnerAcl(IntPtr handle,string sid,bool protectedAcl) {
      IntPtr owner,group,dacl,sacl,descriptor;Check.Need(GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor)==0,"acl_query");
      try {
        Check.Need(owner!=IntPtr.Zero&&new SecurityIdentifier(owner).Value==sid&&dacl!=IntPtr.Zero,"owner_sid_mismatch");
        ushort control;uint revision;Check.Need(GetSecurityDescriptorControl(descriptor,out control,out revision)&&(!protectedAcl||(control&0x1000)!=0),"acl_not_protected");
        AclSize info;Check.Need(GetAclInformation(dacl,out info,(uint)Marshal.SizeOf(typeof(AclSize)),2)&&info.AceCount==1,"acl_unexpected_ace");
        IntPtr ace;Check.Need(GetAce(dacl,0,out ace)&&Marshal.ReadByte(ace)==0,"acl_not_allow");
        uint mask=unchecked((uint)Marshal.ReadInt32(ace,4));Check.Need(mask==0x001f01ff&&new SecurityIdentifier(IntPtr.Add(ace,8)).Value==sid,"acl_rights_or_sid");
        Check.Need((Marshal.ReadByte(ace,1)&~0x13)==0,"acl_ace_flags");
      }finally { LocalFree(descriptor); }
    }
    internal static void DeleteExact(SafeFileHandle handle) { FileDisposition d=new FileDisposition();d.Delete=1;Check.Need(SetFileInformationByHandle(handle,4,ref d,(uint)Marshal.SizeOf(d)),"delete_by_handle"); }
    internal static bool Spawn(string executable,StringBuilder command,IntPtr block,string directory,IntPtr input,out ProcessInfo process) {
      if(input==IntPtr.Zero) { StartupInfo s=new StartupInfo();s.Size=(uint)Marshal.SizeOf(s);return CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x08000404,block,directory,ref s,out process); }
      // Only these two handles are inherited. Ambient PowerShell handles never
      // become child authority through bInheritHandles=true.
      IntPtr list=IntPtr.Zero,array=IntPtr.Zero,security=IntPtr.Zero;SafeFileHandle nul=null;
      try {
        SecurityAttributes a=new SecurityAttributes();a.Length=(uint)Marshal.SizeOf(a);a.Inherit=1;security=Marshal.AllocHGlobal((int)a.Length);Marshal.StructureToPtr(a,security,false);
        nul=CreateFile("NUL",GENERIC_READ|GENERIC_WRITE,3,security,3,0x80,IntPtr.Zero);Check.Need(!nul.IsInvalid,"stdio_nul_create");
        IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);Check.Need(bytes.ToInt64()>0&&bytes.ToInt64()<65536,"attribute_list_size");list=Marshal.AllocHGlobal(bytes);Check.Need(InitializeProcThreadAttributeList(list,1,0,ref bytes),"attribute_list_init");
        array=Marshal.AllocHGlobal(2*IntPtr.Size);Marshal.WriteIntPtr(array,input);Marshal.WriteIntPtr(array,IntPtr.Size,nul.DangerousGetHandle());Check.Need(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),array,new IntPtr(2*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"handle_list_bind");
        StartupInfoEx s=new StartupInfoEx();s.Info.Size=(uint)Marshal.SizeOf(s);s.Info.Flags=0x100;s.Info.StdIn=input;s.Info.StdOut=nul.DangerousGetHandle();s.Info.StdErr=nul.DangerousGetHandle();s.Attributes=list;
        return CreateProcessEx(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,block,directory,ref s,out process);
      }finally { if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(array!=IntPtr.Zero)Marshal.FreeHGlobal(array);if(security!=IntPtr.Zero)Marshal.FreeHGlobal(security);if(nul!=null)nul.Dispose(); }
    }
    internal static IntPtr Job() {
      IntPtr job=CreateJobObject(IntPtr.Zero,null);Check.Need(job!=IntPtr.Zero,"job_create");
      IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended)));
      try { Extended e=new Extended();e.Basic.Flags=0x2000;Marshal.StructureToPtr(e,p,false);Check.Need(SetInformationJobObject(job,9,p,(uint)Marshal.SizeOf(e)),"job_no_breakaway_limit");return job; }
      catch { CloseHandle(job);throw; }finally { Marshal.FreeHGlobal(p); }
    }
    internal static Accounting JobAccounting(IntPtr job) {
      IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Accounting)));uint n;
      try { Check.Need(QueryInformationJobObject(job,1,p,(uint)Marshal.SizeOf(typeof(Accounting)),out n),"job_accounting");return (Accounting)Marshal.PtrToStructure(p,typeof(Accounting)); }finally { Marshal.FreeHGlobal(p); }
    }
    internal static uint[] JobPids(IntPtr job) {
      int cap=1024;IntPtr p=Marshal.AllocHGlobal(8+cap*IntPtr.Size);uint n;
      try { Check.Need(QueryInformationJobObject(job,3,p,(uint)(8+cap*IntPtr.Size),out n),"job_pid_query");int assigned=Marshal.ReadInt32(p),count=Marshal.ReadInt32(p,4);Check.Need(count>=0&&count<=cap&&assigned==count,"job_pid_bound");uint[] a=new uint[count];for(int i=0;i<count;i++)a[i]=checked((uint)(IntPtr.Size==8?Marshal.ReadInt64(p,8+i*8):Marshal.ReadInt32(p,8+i*4)));return a; }finally { Marshal.FreeHGlobal(p); }
    }
    internal static long Birth(IntPtr handle) { FileTime c,e,k,u;Check.Need(GetProcessTimes(handle,out c,out e,out k,out u),"process_birth_query");return c.Value; }
    internal static string Image(IntPtr handle) { StringBuilder image=new StringBuilder(4096);uint length=4096;Check.Need(QueryFullProcessImageName(handle,0,image,ref length)&&length>0&&length<4096,"process_image_query");return image.ToString(); }
    internal static string ProcessSid(IntPtr handle) {
      IntPtr token;Check.Need(OpenProcessToken(handle,8,out token),"process_token");IntPtr value=IntPtr.Zero;
      try { uint n;GetTokenInformation(token,1,IntPtr.Zero,0,out n);Check.Need(n>=IntPtr.Size&&n<=4096,"token_info_size");value=Marshal.AllocHGlobal((int)n);Check.Need(GetTokenInformation(token,1,value,n,out n),"token_info");return new SecurityIdentifier(Marshal.ReadIntPtr(value)).Value; }
      finally { if(value!=IntPtr.Zero)Marshal.FreeHGlobal(value);CloseHandle(token); }
    }
  }

  public sealed class OwnedDirectory : IDisposable {
    public readonly string PathName,OwnerSid,FileId; internal SafeFileHandle Handle; internal Native.FileIdentity Anchor; bool disposed;
    private OwnedDirectory(string path,string sid,SafeFileHandle handle) { PathName=path;OwnerSid=sid;Handle=handle;Anchor=Native.Identity(handle);FileId=Anchor.Label;AssertBound(); }
    public static OwnedDirectory Create(string path) {
      Check.Host();Check.PathName(path);Check.NoReparseAncestors(path,false);Check.Need(!File.Exists(path)&&!Directory.Exists(path),"owned_root_not_fresh");string sid=WindowsIdentity.GetCurrent().User.Value;
      Native.CreateOwnedDirectory(path,sid);SafeFileHandle h=null;
      try { h=Native.OpenFile(path,Native.GENERIC_READ|Native.DELETE,true,false);return new OwnedDirectory(path,sid,h); }
      catch { if(h!=null)h.Dispose();throw; }
    }
    public void AssertBound() {
      Check.Need(!disposed&&!Handle.IsClosed,"owned_root_closed");Check.NoReparseAncestors(PathName,true);Native.CheckOwnerAcl(Handle.DangerousGetHandle(),OwnerSid,true);
      Native.FileIdentity held=Native.Identity(Handle);Check.Need(held.Directory&&!held.Reparse&&Anchor.SameObject(held),"owned_directory_identity");
      using(SafeFileHandle named=Native.OpenFile(PathName,Native.GENERIC_READ,true,false,true))Check.Need(Anchor.SameObject(Native.Identity(named)),"owned_directory_name_drift");
    }
    public string Leaf(string name) { AssertBound();Check.Need(name!=null&&name.Length>0&&name.IndexOfAny(new char[]{'\\','/',':','\0'})<0&&!String.Equals(name,"MEMORY.md",StringComparison.OrdinalIgnoreCase),"leaf_forbidden");return System.IO.Path.Combine(PathName,name); }
    public void AssertOwnedFile(string name) {
      string path=Leaf(name);Check.NoReparseAncestors(path,true);using(SafeFileHandle h=Native.OpenFile(path,Native.GENERIC_READ,false,false)) { Native.FileIdentity i=Native.Identity(h);Check.Need(!i.Directory&&!i.Reparse&&i.Links==1,"owned_file_identity");Native.CheckOwnerAcl(h.DangerousGetHandle(),OwnerSid,false); }
    }
    public string[] EntryNames() { AssertBound();return Directory.GetFileSystemEntries(PathName).Select(System.IO.Path.GetFileName).OrderBy(x=>x,StringComparer.Ordinal).ToArray(); }
    public void DeleteFilesAndDirectory(string[] expectedNames) {
      AssertBound();string[] expected=expectedNames.OrderBy(x=>x,StringComparer.Ordinal).ToArray();Check.Need(EntryNames().SequenceEqual(expected,StringComparer.Ordinal),"owned_directory_unknown_entries");
      foreach(string name in expected) { string path=Leaf(name);Check.NoReparseAncestors(path,true);using(SafeFileHandle h=Native.OpenFile(path,Native.GENERIC_READ|Native.DELETE,false,false)) { Native.FileIdentity i=Native.Identity(h);Check.Need(!i.Directory&&!i.Reparse&&i.Links==1,"cleanup_file_identity");Native.CheckOwnerAcl(h.DangerousGetHandle(),OwnerSid,false);Native.DeleteExact(h); } }
      Check.Need(EntryNames().Length==0,"owned_directory_not_empty");Native.DeleteExact(Handle);Dispose();Check.Need(!Directory.Exists(PathName)&&!File.Exists(PathName),"owned_directory_not_removed");
    }
    public void Dispose() { if(disposed)return;disposed=true;if(Handle!=null)Handle.Dispose(); }
  }

  internal sealed class PendingOriginal {
    internal IntPtr Handle;internal uint Pid;internal string OperationId;internal bool JobAssigned,ExitObserved;internal ProcessProof Proof;
    internal PendingOriginal(IntPtr handle,uint pid,string operationId) { Handle=handle;Pid=pid;OperationId=operationId; }
  }
  public sealed class ProcessProof {
    public readonly string Role,ImagePath,ImageSha256,OwnerSid,CreationOperationId,JobInstanceId,Provenance;public readonly string[] OriginalOperationIds;
    public readonly uint Pid;public readonly long CreationTime;
    internal IntPtr Handle,InputWriter;internal bool Waited,Resumed,Rejected,JobAssigned;internal string AuxiliaryPath,AuxiliarySha256;
    internal ProcessProof(string role,uint pid,IntPtr handle,string image,string hash,string sid,string jobId,string operationId,string[] originals) {
      Role=role;Pid=pid;Handle=handle;ImagePath=image;ImageSha256=hash;OwnerSid=sid;JobInstanceId=jobId;CreationOperationId=operationId;
      Provenance=operationId==null?"retained-job-member":"original-createprocess-handle";OriginalOperationIds=originals;CreationTime=Native.Birth(handle);
    }
  }
  // Serial QA fault probes only; these are API return observations, not a
  // general process-tree cleanup proof.
  public static class QaRollbackStatus {
    public static bool Executed,JobWasCreated,JobCloseReturned,JournalDisposeReturned;
    public static string FirstFailureCode;
    internal static void Reset(){Executed=false;JobWasCreated=false;JobCloseReturned=false;JournalDisposeReturned=false;FirstFailureCode=null;}
  }
  public sealed class Lifecycle : IDisposable {
    readonly OwnedDirectory root;IntPtr job;FileStream journal;readonly string sid;readonly string qaFault;
    readonly Dictionary<string,ProcessProof> roles=new Dictionary<string,ProcessProof>(StringComparer.Ordinal);
    readonly List<PendingOriginal> originals=new List<PendingOriginal>();
    readonly HashSet<string> attempted=new HashSet<string>(StringComparer.Ordinal);readonly long origin,hardEnd,activeEnd;long sequence;bool closed,disposed,red;
    public readonly string JobInstanceId=Guid.NewGuid().ToString("N");public readonly string JournalPath;
    public string FirstFailureCode { get;private set; }public bool EmergencyOriginalExitsObserved { get;private set; }
    public bool AllWaited { get { return roles.Values.All(x=>x.Waited)&&originals.All(x=>x.ExitObserved); } }public int RetainedCount { get { return roles.Count; } }
    public Lifecycle(OwnedDirectory ownedRoot,string journalName,int totalMs,int cleanupMs) : this(ownedRoot,journalName,totalMs,cleanupMs,null) { }
    public Lifecycle(OwnedDirectory ownedRoot,string journalName,int totalMs,int cleanupMs,string fault) {
      Check.Host();Check.Need(totalMs>=10000&&totalMs<=120000&&cleanupMs>=2000&&cleanupMs<=10000&&cleanupMs<totalMs,"budget_invalid");
      Check.Need(fault==null||new string[]{"after_create_before_proof","registered_before_job","constructor_after_job","constructor_journal_flush","close_flush"}.Contains(fault),"qa_fault_invalid");qaFault=fault;QaRollbackStatus.Reset();
      origin=Stopwatch.GetTimestamp();hardEnd=origin+MsTicks(totalMs);activeEnd=hardEnd-MsTicks(cleanupMs);root=ownedRoot;root.AssertBound();sid=root.OwnerSid;JournalPath=root.Leaf(journalName);
      SafeFileHandle raw=null;bool published=false;
      try {
        raw=Native.CreateOwnedFile(JournalPath,Native.GENERIC_WRITE,sid);journal=new FileStream(raw,FileAccess.Write,4096,false);raw=null;
        Row("job_close_cleanup_prepared","\"killOnJobClose\":true,\"exactWaitClaim\":false,\"jobInstanceId\":\""+JobInstanceId+"\"");job=Native.Job();QaRollbackStatus.JobWasCreated=true;Fault("constructor_after_job");
        Row("ready","\"native\":true,\"handleAuthority\":true,\"jobInstanceId\":\""+JobInstanceId+"\",\"ownedDirectoryFileId\":\""+root.FileId+"\",\"ownerSid\":\""+sid+"\",\"originTicks\":\""+origin+"\",\"hardEndTicks\":\""+hardEnd+"\",\"activeEndTicks\":\""+activeEnd+"\"");published=true;
      }catch(Exception error){Remember(error);QaRollbackStatus.FirstFailureCode=FirstFailureCode;throw;}
      finally {
        if(!published) {
          QaRollbackStatus.Executed=true;
          // Each rollback is independent and preserves the original failure.
          try { if(job!=IntPtr.Zero){QaRollbackStatus.JobCloseReturned=Native.CloseHandle(job);if(!QaRollbackStatus.JobCloseReturned)Remember(new ProofFailure("constructor_job_close_failed"));}else QaRollbackStatus.JobCloseReturned=true; }
          catch(Exception error){Remember(error);}
          finally { job=IntPtr.Zero;
            try { if(journal!=null)journal.Dispose();QaRollbackStatus.JournalDisposeReturned=true; }
            catch(Exception error){Remember(error);}
            finally { try{if(raw!=null)raw.Dispose();}catch(Exception error){Remember(error);}finally{journal=null;disposed=true;QaRollbackStatus.FirstFailureCode=FirstFailureCode;} }
          }
        }
      }
    }
    void Fault(string stage) { if(qaFault==stage)throw new ProofFailure("qa_injected_"+stage); }
    void Remember(Exception error) { red=true;if(FirstFailureCode==null)FirstFailureCode=error is ProofFailure?((ProofFailure)error).Code:"managed_operation_failed"; }
    static long MsTicks(int ms) { return checked((long)(Stopwatch.Frequency*(ms/1000.0))); }
    long Now { get { return Stopwatch.GetTimestamp(); } }
    void NeedTime(bool cleanup=false) { Check.Need(Now<(cleanup?hardEnd:activeEnd),"deadline_exceeded"); }
    uint RemainingMs(int cap,bool cleanup) { NeedTime(cleanup);double left=((cleanup?hardEnd:activeEnd)-Now)*1000.0/Stopwatch.Frequency;return (uint)Math.Max(1,Math.Min(cap,Math.Floor(left))); }
    void Row(string type,string fields) {
      long at=Now;Check.Need(!disposed&&at<hardEnd,"journal_deadline");string line="{\"sequence\":"+(++sequence)+",\"event\":\""+type+"\",\"atTicks\":\""+at+"\",\"frequency\":\""+Stopwatch.Frequency+"\""+(String.IsNullOrEmpty(fields)?"":","+fields)+"}\n";
      byte[] bytes=Encoding.UTF8.GetBytes(line);Check.Need(bytes.Length<=8192&&journal.Length+bytes.Length<=4194304,"journal_limit");journal.Write(bytes,0,bytes.Length);Fault("constructor_journal_flush");journal.Flush(true);Check.Need(Now<hardEnd,"journal_acknowledgement_late");
    }
    static string RoleFields(ProcessProof p) { return "\"role\":\""+Check.Escape(p.Role)+"\",\"pid\":"+p.Pid+",\"creationTime\":\""+p.CreationTime+"\",\"imageSha256\":\""+p.ImageSha256+"\",\"ownerSid\":\""+p.OwnerSid+"\",\"jobInstanceId\":\""+p.JobInstanceId+"\",\"provenance\":\""+p.Provenance+"\",\"creationOperationId\":"+(p.CreationOperationId==null?"null":"\""+p.CreationOperationId+"\"")+",\"originalOperationIds\":["+String.Join(",",p.OriginalOperationIds.Select(x=>"\""+x+"\""))+"]"; }
    static string Quote(string value) {
      Check.Need(value!=null&&value.Length<=16384&&value.IndexOf('\0')<0&&value.IndexOf('\r')<0&&value.IndexOf('\n')<0,"argument_invalid");StringBuilder result=new StringBuilder("\"");int slashes=0;
      foreach(char c in value) { if(c=='\\'){slashes++;continue;}if(c=='"'){result.Append('\\',slashes*2+1).Append('"');slashes=0;}else{result.Append('\\',slashes).Append(c);slashes=0;} }return result.Append('\\',slashes*2).Append('"').ToString();
    }
    static IntPtr EnvironmentBlock(IDictionary<string,string> environment,OwnedDirectory ownedRoot,out string digest) {
      string[] allowed={"HOME","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP","SystemRoot","SystemDrive","PATH","EG_OWNED_ROOT","EG_FIXTURE_TOKEN"};
      Check.Need(environment!=null&&environment.Count>=8&&environment.Count<=allowed.Length,"environment_invalid");SortedDictionary<string,string> sorted=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      foreach(KeyValuePair<string,string> item in environment) { Check.Need(allowed.Contains(item.Key,StringComparer.Ordinal)&&item.Value!=null&&item.Value.Length<16384&&item.Value.IndexOf('\0')<0,"environment_invalid");sorted.Add(item.Key,item.Value); }
      foreach(string key in new string[]{"HOME","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP","EG_OWNED_ROOT"})Check.Need(sorted.ContainsKey(key)&&String.Equals(sorted[key],ownedRoot.PathName,StringComparison.Ordinal),"environment_profile_unbound");
      StringBuilder b=new StringBuilder();foreach(KeyValuePair<string,string> item in sorted)b.Append(item.Key).Append('=').Append(item.Value).Append('\0');b.Append('\0');string text=b.ToString();digest=Check.Hash(Encoding.Unicode.GetBytes(text));return Marshal.StringToHGlobalUni(text);
    }
    public ProcessProof Launch(string role,string executable,string expectedSha256,string[] arguments,IDictionary<string,string> environment,string auxiliaryPath,string auxiliarySha256,bool rejectAfterBirth,bool pipeInput) {
      NeedTime();root.AssertBound();Check.Need(!closed&&!attempted.Contains(role)&&role!=null&&role.Length>0&&role.Length<=64&&role.All(c=>Char.IsLetterOrDigit(c)||c=='_'||c=='-'),"role_invalid_or_consumed");attempted.Add(role);
      Check.Need(Check.HashFile(executable)==expectedSha256,"executable_hash_mismatch");Check.Need(auxiliaryPath==null||Check.HashFile(auxiliaryPath)==auxiliarySha256,"auxiliary_hash_mismatch");
      StringBuilder command=new StringBuilder(Quote(executable));foreach(string argument in arguments)command.Append(' ').Append(Quote(argument));Check.Need(command.Length<30000,"command_limit");
      IntPtr block=IntPtr.Zero,read=IntPtr.Zero,writer=IntPtr.Zero;Native.ProcessInfo info=new Native.ProcessInfo();PendingOriginal pending=null;ProcessProof proof=null;bool published=false;
      string operationId=Guid.NewGuid().ToString("N");
      try {
        string environmentDigest;block=EnvironmentBlock(environment,root,out environmentDigest);
        if(pipeInput)Check.Need(Native.CreatePipe(out read,out writer,IntPtr.Zero,0)&&Native.SetHandleInformation(read,1,1)&&Native.SetHandleInformation(writer,1,0),"stdin_pipe_create");
        Row("create_prepared","\"role\":\""+Check.Escape(role)+"\",\"creationOperationId\":\""+operationId+"\",\"jobInstanceId\":\""+JobInstanceId+"\",\"imageSha256\":\""+expectedSha256+"\",\"argumentsUtf16Sha256\":\""+Check.Hash(Encoding.Unicode.GetBytes(command.ToString()))+"\",\"environmentUtf16Sha256\":\""+environmentDigest+"\",\"cwdFileId\":\""+root.FileId+"\",\"creationInputsBound\":true,\"remoteParametersRead\":false,\"emergencyOriginalHandleCleanupArmed\":true,\"emergencyWaitScopeMs\":3000,\"emergencyPastDeadlineIsRed\":true,\"stdinPipeBound\":"+(pipeInput?"true":"false"));NeedTime();
        Check.Need(Native.Spawn(executable,command,block,root.PathName,read,out info),"process_create");
        // The native out-info retains the raw original handle immediately.
        // Before any birth query, allocation, journal or deadline check it is
        // under the unconditional finally cleanup plan already persisted above.
        pending=new PendingOriginal(info.Process,info.ProcessId,operationId);originals.Add(pending);info.Process=IntPtr.Zero;
        Fault("after_create_before_proof");
        proof=new ProcessProof(role,pending.Pid,pending.Handle,executable,expectedSha256,sid,JobInstanceId,operationId,new string[]{operationId});pending.Proof=proof;proof.AuxiliaryPath=auxiliaryPath;proof.AuxiliarySha256=auxiliarySha256;roles.Add(role,proof);
        Row("process_created",RoleFields(proof)+",\"originalHandleRetained\":true");Fault("registered_before_job");
        Row("job_assign_prepared",RoleFields(proof));NeedTime();Check.Need(Native.AssignProcessToJobObject(job,proof.Handle),"job_assign");pending.JobAssigned=true;proof.JobAssigned=true;Row("job_assigned",RoleFields(proof));
        VerifyProof(proof,true,false);Row("birth_proved",RoleFields(proof));
        if(rejectAfterBirth) { proof.Rejected=true;Row("target_rejected",RoleFields(proof));Stop(proof,true);Wait(proof,RemainingMs(2000,true),true);published=true;return proof; }
        Row("resume_prepared",RoleFields(proof));NeedTime();uint suspend=Native.ResumeThread(info.Thread);Check.Need(suspend==1,"resume_unverified");proof.Resumed=true;proof.InputWriter=writer;writer=IntPtr.Zero;NeedTime();Row("resumed",RoleFields(proof));published=true;return proof;
      }catch(Exception error) { Remember(error);throw; }
      finally {
        try {
          if(!published&&(pending!=null||info.Process!=IntPtr.Zero)) {
            // No Row/NeedTime/RemainingMs/proof construction is permitted here.
            // Assigned and unassigned originals have the same predeclared raw
            // handle cleanup authority. A late cleanup is RED, never PASS.
            IntPtr original=pending==null?info.Process:pending.Handle;
            bool observed=EmergencyTerminateAndWait(original,Now+MsTicks(3000));
            if(pending!=null){pending.ExitObserved=observed;if(pending.Proof!=null)pending.Proof.Waited=observed;}
            if(!observed)Remember(new ProofFailure("original_emergency_exit_unverified"));
          }
        }finally {
          try { if(info.Thread!=IntPtr.Zero)Native.CloseHandle(info.Thread); }
          finally { try { if(info.Process!=IntPtr.Zero)Native.CloseHandle(info.Process); }
            finally { try { if(block!=IntPtr.Zero)Marshal.FreeHGlobal(block); }
              finally { try { if(read!=IntPtr.Zero)Native.CloseHandle(read); }finally { if(writer!=IntPtr.Zero)Native.CloseHandle(writer); } }
            }
          }
        }
      }
    }
    // Predeclared original-handle/owned-Job emergency authority does not depend
    // on successful logging, healthy clocks, proof construction or Job assignment.
    bool EmergencyTerminateAndWait(IntPtr handle,long emergencyEnd) {
      if(handle==IntPtr.Zero)return false;
      try {
        uint state=Native.WaitForSingleObject(handle,0);if(state!=0)Native.TerminateProcess(handle,1);
        double ms=Math.Max(0,(emergencyEnd-Now)*1000.0/Stopwatch.Frequency);uint cap=(uint)Math.Min(3000,Math.Floor(ms));
        uint status=Native.WaitForSingleObject(handle,cap);uint code;return status==0&&Native.GetExitCodeProcess(handle,out code)&&code!=259;
      }catch { return false; }
    }
    ProcessProof Get(string role) { Check.Need(roles.ContainsKey(role),"authority_unknown");return roles[role]; }
    void VerifyProof(ProcessProof proof,bool target,bool allowUnassigned) {
      Check.Need(proof.Handle!=IntPtr.Zero&&Native.Birth(proof.Handle)==proof.CreationTime,"process_birth_drift");
      bool inside;Check.Need(Native.IsProcessInJob(proof.Handle,job,out inside)&&(inside||allowUnassigned),"process_job_drift");
      Check.Need(Native.ProcessSid(proof.Handle)==sid,"process_sid_drift");
      if(target) { Check.Need(String.Equals(Native.Image(proof.Handle),proof.ImagePath,StringComparison.OrdinalIgnoreCase)&&Check.HashFile(proof.ImagePath)==proof.ImageSha256,"process_image_drift");if(proof.AuxiliaryPath!=null)Check.Need(Check.HashFile(proof.AuxiliaryPath)==proof.AuxiliarySha256,"launch_input_drift"); }
    }
    public void Verify(string role,long expectedCreationTime,string expectedImageSha256) {
      NeedTime();ProcessProof proof=Get(role);Check.Need(proof.CreationTime==expectedCreationTime&&proof.ImageSha256==expectedImageSha256,"supplied_birth_or_image_mismatch");VerifyProof(proof,true,false);Row("verified",RoleFields(proof));NeedTime();
    }
    public ProcessProof[] RetainDescendants(string expectedImage,string expectedSha256) {
      NeedTime();root.AssertBound();uint[] ids=Native.JobPids(job);List<ProcessProof> pinned=new List<ProcessProof>();
      foreach(uint pid in ids) {
        if(roles.Values.Any(x=>x.Pid==pid))continue;IntPtr handle=Native.OpenProcess(Native.SYNCHRONIZE|Native.QUERY_LIMITED|Native.PROCESS_TERMINATE,false,pid);Check.Need(handle!=IntPtr.Zero,"descendant_handle_unavailable");
        ProcessProof p=null;try { p=new ProcessProof("descendant_"+pid,pid,handle,expectedImage,expectedSha256,sid,JobInstanceId,null,originals.Where(x=>x.JobAssigned&&x.Proof!=null&&x.Proof.Resumed).Select(x=>x.OperationId).ToArray());VerifyProof(p,true,false);Check.Need(Native.JobPids(job).Contains(pid),"descendant_membership_unstable");p.JobAssigned=true;Row("descendant_retained",RoleFields(p)+",\"jobMemberVerified\":true");roles.Add(p.Role,p);pinned.Add(p);handle=IntPtr.Zero; }finally { if(handle!=IntPtr.Zero)Native.CloseHandle(handle); }
      }
      Native.Accounting a=Native.JobAccounting(job);Check.Need(a.TotalProcesses==(uint)roles.Count,"unknown_job_history");NeedTime();return pinned.ToArray();
    }
    public ProcessProof RetainSpecificDescendant(string role,uint pid,string expectedImage,string expectedSha256) {
      // This supports heterogeneous driver/App/WebView images one at a time.
      // Job membership proves containment, not a direct PPID or argv/env/CWD.
      NeedTime();root.AssertBound();Check.Need(role!=null&&role.Length>0&&role.Length<=64&&role.All(c=>Char.IsLetterOrDigit(c)||c=='_'||c=='-')&&!attempted.Contains(role)&&!roles.ContainsKey(role)&&!roles.Values.Any(x=>x.Pid==pid),"descendant_role_invalid");attempted.Add(role);
      Check.Need(Check.HashFile(expectedImage)==expectedSha256&&Native.JobPids(job).Contains(pid),"descendant_input_or_membership");IntPtr handle=Native.OpenProcess(Native.SYNCHRONIZE|Native.QUERY_LIMITED|Native.PROCESS_TERMINATE,false,pid);
      Check.Need(handle!=IntPtr.Zero,"descendant_handle_unavailable");
      try { ProcessProof proof=new ProcessProof(role,pid,handle,expectedImage,expectedSha256,sid,JobInstanceId,null,originals.Where(x=>x.JobAssigned&&x.Proof!=null&&x.Proof.Resumed).Select(x=>x.OperationId).ToArray());VerifyProof(proof,true,false);Check.Need(Native.JobPids(job).Contains(pid),"descendant_membership_unstable");proof.JobAssigned=true;Row("descendant_retained",RoleFields(proof)+",\"jobMemberVerified\":true");NeedTime();roles.Add(role,proof);handle=IntPtr.Zero;return proof; }
      finally { if(handle!=IntPtr.Zero)Native.CloseHandle(handle); }
    }
    public void AssertFullyRetained() {
      NeedTime();Native.Accounting accounting=Native.JobAccounting(job);Check.Need(accounting.TotalProcesses==(uint)roles.Count&&Native.JobPids(job).All(pid=>roles.Values.Any(p=>p.Pid==pid)),"unknown_job_history");
    }
    void Stop(ProcessProof proof,bool cleanup) {
      NeedTime(cleanup);Check.Need(Native.Birth(proof.Handle)==proof.CreationTime,"process_birth_drift");uint state=Native.WaitForSingleObject(proof.Handle,0);Check.Need(state==0||state==258,"process_wait_failed");
      if(state==0){Row("already_exited",RoleFields(proof)+",\"cleanupScope\":"+(cleanup?"true":"false"));return;}VerifyProof(proof,false,true);Row("terminate_prepared",RoleFields(proof)+",\"cleanupScope\":"+(cleanup?"true":"false"));NeedTime(cleanup);
      if(Native.TerminateProcess(proof.Handle,1))Row("terminate_dispatched",RoleFields(proof)+",\"cleanupScope\":"+(cleanup?"true":"false"));else { Check.Need(Native.WaitForSingleObject(proof.Handle,0)==0,"terminate_failed");Row("terminate_not_dispatched_already_exited",RoleFields(proof)+",\"cleanupScope\":"+(cleanup?"true":"false")); }NeedTime(cleanup);
    }
    void Wait(ProcessProof proof,uint milliseconds,bool cleanup) {
      NeedTime(cleanup);Check.Need(Native.Birth(proof.Handle)==proof.CreationTime,"wait_birth_drift");uint status=Native.WaitForSingleObject(proof.Handle,milliseconds);NeedTime(cleanup);Check.Need(status==0,"process_exit_not_observed");uint code;Check.Need(Native.GetExitCodeProcess(proof.Handle,out code)&&code!=259,"exit_code_unverified");proof.Waited=true;foreach(PendingOriginal original in originals)if(original.Handle==proof.Handle)original.ExitObserved=true;Row("exact_handle_wait",RoleFields(proof)+",\"exitCode\":"+code+",\"cleanupScope\":"+(cleanup?"true":"false"));NeedTime(cleanup);
    }
    public void StopExact(string role,long expectedCreationTime) { NeedTime();ProcessProof p=Get(role);Check.Need(p.CreationTime==expectedCreationTime,"supplied_birth_mismatch");VerifyProof(p,true,false);Stop(p,false); }
    public void WaitExact(string role,int capMs) { Check.Need(capMs>0&&capMs<=15000,"wait_cap_invalid");Wait(Get(role),RemainingMs(capMs,false),false); }
    public void SendEof(string role,long expectedCreationTime) {
      NeedTime();ProcessProof p=Get(role);Check.Need(p.CreationTime==expectedCreationTime&&p.InputWriter!=IntPtr.Zero,"stdin_authority_invalid");VerifyProof(p,true,false);Row("stdin_eof_prepared",RoleFields(p));NeedTime();Check.Need(Native.CloseHandle(p.InputWriter),"stdin_eof_failed");p.InputWriter=IntPtr.Zero;Row("stdin_eof_dispatched",RoleFields(p));NeedTime();
    }
    public uint ActiveCount() { return Native.JobAccounting(job).ActiveProcesses; }
    public void Close() {
      if(closed)return;closed=true;
      try {
        NeedTime(true);root.AssertBound();Native.Accounting before=Native.JobAccounting(job);
        Check.Need(originals.All(x=>x.JobAssigned&&x.Proof!=null),"original_assignment_or_proof_incomplete");
        Check.Need(before.TotalProcesses==(uint)roles.Count,"unknown_job_history");
        foreach(ProcessProof proof in roles.Values)if(!proof.Waited)Stop(proof,true);
        foreach(ProcessProof proof in roles.Values)if(!proof.Waited)Wait(proof,RemainingMs(3000,true),true);
        Native.Accounting after=Native.JobAccounting(job);Check.Need(after.ActiveProcesses==0&&Native.JobPids(job).Length==0,"job_not_empty");Check.Need(after.TotalProcesses==(uint)roles.Count,"unknown_job_history");
        foreach(ProcessProof proof in roles.Values)Check.Need(Check.HashFile(proof.ImagePath)==proof.ImageSha256,"cleanup_image_drift");
        Row("cleanup_complete","\"allExactHandlesWaited\":"+(AllWaited?"true":"false")+",\"unknownCount\":0,\"red\":"+(red?"true":"false")+",\"jobActiveCount\":0,\"jobTotalCount\":"+after.TotalProcesses+",\"retainedCount\":"+roles.Count+",\"jobInstanceId\":\""+JobInstanceId+"\"");
      }catch(Exception error) { Remember(error);try { Row("cleanup_red","\"exactWaitClaim\":false"); }catch { } }
      finally {
        // Always attempt raw retained originals (including unassigned and
        // unregistered proofs) before handle close. All termination attempts
        // happen first; exact waits share one finite emergency window. Logging
        // and deadline failure cannot bypass this mandatory resource path.
        long emergencyEnd=Now+MsTicks(3000);
        try {
          foreach(PendingOriginal original in originals)if(!original.ExitObserved&&original.Handle!=IntPtr.Zero)try { Native.TerminateProcess(original.Handle,1); }catch { }
          foreach(ProcessProof proof in roles.Values)if(!proof.Waited&&proof.Handle!=IntPtr.Zero)try { Native.TerminateProcess(proof.Handle,1); }catch { }
          if(red&&job!=IntPtr.Zero)try { Native.TerminateJobObject(job,1); }catch { }
          foreach(PendingOriginal original in originals) {
            if(!original.ExitObserved)original.ExitObserved=EmergencyTerminateAndWait(original.Handle,emergencyEnd);
            if(original.Proof!=null)original.Proof.Waited=original.ExitObserved;
            if(!original.ExitObserved)Remember(new ProofFailure("original_emergency_exit_unverified"));
          }
          foreach(ProcessProof proof in roles.Values)if(!proof.Waited){proof.Waited=EmergencyTerminateAndWait(proof.Handle,emergencyEnd);if(!proof.Waited)Remember(new ProofFailure("descendant_emergency_exit_unverified"));}
          EmergencyOriginalExitsObserved=originals.All(x=>x.ExitObserved);
        }catch(Exception error) { Remember(error); }
        finally {
          try {
            foreach(ProcessProof proof in roles.Values) {
              try { if(proof.InputWriter!=IntPtr.Zero&&!Native.CloseHandle(proof.InputWriter))Remember(new ProofFailure("stdin_handle_close_failed")); }catch(Exception error){Remember(error);}finally{proof.InputWriter=IntPtr.Zero;}
              if(proof.Provenance=="retained-job-member")try{if(proof.Handle!=IntPtr.Zero&&!Native.CloseHandle(proof.Handle))Remember(new ProofFailure("descendant_handle_close_failed"));}catch(Exception error){Remember(error);}finally{proof.Handle=IntPtr.Zero;}
            }
            foreach(PendingOriginal original in originals)try{if(original.Handle!=IntPtr.Zero&&!Native.CloseHandle(original.Handle))Remember(new ProofFailure("original_handle_close_failed"));}catch(Exception error){Remember(error);}finally{original.Handle=IntPtr.Zero;if(original.Proof!=null)original.Proof.Handle=IntPtr.Zero;}
          }finally {
            try { if(job!=IntPtr.Zero&&!Native.CloseHandle(job))Remember(new ProofFailure("job_handle_close_failed")); }catch(Exception error){Remember(error);}finally{job=IntPtr.Zero;}
            try { if(journal!=null){Fault("close_flush");journal.Flush(true);} }catch(Exception error){Remember(error);}
            finally { try { if(journal!=null)journal.Dispose(); }catch(Exception error){Remember(error);}finally{journal=null;disposed=true;} }
          }
        }
      }
      if(red)throw new ProofFailure(FirstFailureCode??"cleanup_red");
    }
    public void Dispose() { if(!closed)Close(); }
  }
}
